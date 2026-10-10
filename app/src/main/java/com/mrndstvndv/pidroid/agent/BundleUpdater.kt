package com.mrndstvndv.pidroid.agent

import android.content.Context
import android.util.Log
import com.mrndstvndv.pidroid.BuildConfig
import com.mrndstvndv.pidroid.bridge.Capabilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/** An agent release's update manifest (agent-update.json): a bundle the updater may download and install. */
data class UpdateManifest(
    val version: String,
    val code: Int,
    val minHostApi: Int,
    val url: String,
    val sha256: String,
    /** Base64 signature of the zip bytes, or null when the release was published unsigned. */
    val sig: String?,
    val apkUrl: String,
)

/**
 * Finds agent updates among the project's GitHub releases, downloads the newest one this host can run, and installs it.
 *  - Stable follows the latest release. Prerelease opt-in reads the release list and takes the highest code.
 *  - A candidate must be newer than every bundle installed and than the running one, and not blocked. A candidate that
 *    needs a newer app is not downloaded; its APK is offered as an app update instead.
 *  - Only signed bundles are installed (BundleVerifier with allowUnverified = false), checked against the sha256 of the
 *    manifest. A pinned device gets the check recorded, but nothing is downloaded.
 *  - An installed bundle is applied once the agent is idle (AgentProcessManager.restartWhenIdle).
 *
 * Every check ends with BundleStore.recordCheck, carrying its error message if it failed.
 */
object BundleUpdater {
    private const val TAG = "BundleUpdater"
    private const val STABLE_URL = "https://github.com/mrndstvndv/pidroid/releases/latest/download/agent-update.json"
    private const val RELEASES_URL = "https://api.github.com/repos/mrndstvndv/pidroid/releases?per_page=10"
    private const val UPDATE_ASSET = "agent-update.json"
    private const val USER_AGENT = "Pidroid"
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 60_000
    private const val MAX_REDIRECTS = 5
    private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
    private const val HTTP_NOT_FOUND = 404
    private const val MAX_JSON_BYTES = 4L * 1024 * 1024
    private const val MAX_DOWNLOAD_BYTES = 300L * 1024 * 1024
    /** How long after a check before the next automatic one. */
    private const val CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000
    /** The first automatic check runs this long after the service starts, when no check ran recently. */
    private const val FIRST_CHECK_DELAY_MS = 30_000L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val checking = AtomicBoolean(false)
    private var scheduleJob: Job? = null

    /** True while a check runs, from the moment check() accepts it until its result is recorded. */
    val isChecking: Boolean
        get() = checking.get()

    /**
     * Starts an update check in the background, unless one is already running. A check that is not [force]d is skipped
     * when the last one finished less than CHECK_INTERVAL_MS ago. Returns at once; [isChecking] is true while it runs.
     */
    fun check(context: Context, force: Boolean = false) {
        val app = context.applicationContext
        if (!force && System.currentTimeMillis() - BundleStore.state(app).lastCheck < CHECK_INTERVAL_MS) return
        if (!checking.compareAndSet(false, true)) return
        scope.launch {
            try {
                val failure = try {
                    update(app)
                    null
                } catch (e: Exception) {
                    Log.w(TAG, "Update check failed", e)
                    e.message ?: e.javaClass.simpleName
                }
                BundleStore.recordCheck(app, failure)
            } catch (e: Exception) {
                Log.w(TAG, "Could not record the update check", e)
            } finally {
                // Cleared last: a status read that sees checking=false also sees the new lastCheck.
                checking.set(false)
            }
        }
    }

    /**
     * Checks for updates now and then every CHECK_INTERVAL_MS, starting from the last check, so a restart does not check
     * again right away. Starting it twice keeps the first schedule. Stop it with [cancelSchedule].
     */
    @Synchronized
    fun schedule(context: Context) {
        if (scheduleJob?.isActive == true) return
        val app = context.applicationContext
        scheduleJob = scope.launch {
            val sinceLast = (System.currentTimeMillis() - BundleStore.state(app).lastCheck).coerceAtLeast(0L)
            delay(if (sinceLast >= CHECK_INTERVAL_MS) FIRST_CHECK_DELAY_MS else CHECK_INTERVAL_MS - sinceLast)
            while (true) {
                check(app)
                delay(CHECK_INTERVAL_MS)
            }
        }
    }

    @Synchronized
    fun cancelSchedule() {
        scheduleJob?.cancel()
        scheduleJob = null
    }

    /** One check, on the background thread. Throws when the check fails; [check] records the outcome. */
    private fun update(app: Context) {
        val state = BundleStore.state(app)
        val newest = discover(state.prerelease)
            .filter { it.code !in state.blocked }
            .maxByOrNull { it.code }
        val floor = maxOf(BundleStore.activeCode(app) ?: 0, state.bundles.keys.maxOrNull() ?: 0)
        if (newest == null || newest.code <= floor) {
            BundleStore.setAppUpdate(app, null)
            return
        }
        if (newest.minHostApi > BuildConfig.HOST_API) {
            BundleStore.setAppUpdate(app, AppUpdate(newest.version, newest.apkUrl))
            return
        }
        BundleStore.setAppUpdate(app, null)
        // A pinned device only learns that an update exists; it stays on the pinned bundle.
        if (state.pinned != null) return
        val signature = newest.sig ?: throw IllegalStateException("Release ${newest.version} is not signed")

        val work = BundleStore.newStagingDir(app)
        try {
            val zip = File(work, "agent.zip")
            download(newest.url, zip)
            val verified = BundleVerifier.verifyZip(app, zip, newest.sha256, signature, allowUnverified = false)
            BundleStore.install(app, verified.dir, "ota", verified.verified)
        } finally {
            BundleStore.deleteTree(work)
        }
        Log.i(TAG, "Installed agent ${newest.version} (build ${newest.code})")

        if (BundleStore.pendingActivation(app) != null) {
            val version = newest.version
            AgentProcessManager.restartWhenIdle(app) {
                runCatching {
                    Capabilities.showNotification(app, "Agent updated to $version", "The agent restarted with the new version.")
                }.onFailure { Log.w(TAG, "Could not post the update notification", it) }
            }
        }
    }

    /** The release manifests this channel offers. Stable is the latest release; prerelease reads the release list. */
    private fun discover(prerelease: Boolean): List<UpdateManifest> {
        if (!prerelease) {
            // No release yet is not an error: there is simply nothing to update to.
            val text = fetchText(STABLE_URL, accept = null) ?: return emptyList()
            return listOf(parseUpdate(text))
        }
        val releases = fetchText(RELEASES_URL, accept = "application/vnd.github+json")
            ?.let { JSONArray(it) } ?: return emptyList()
        val found = mutableListOf<UpdateManifest>()
        for (i in 0 until releases.length()) {
            val release = releases.optJSONObject(i) ?: continue
            if (release.optBoolean("draft")) continue
            val assets = release.optJSONArray("assets") ?: continue
            val asset = (0 until assets.length())
                .mapNotNull { assets.optJSONObject(it) }
                .firstOrNull { it.optString("name") == UPDATE_ASSET } ?: continue
            val url = asset.optString("browser_download_url")
            if (url.isBlank()) continue
            val text = fetchText(url, accept = null) ?: continue
            try {
                found += parseUpdate(text)
            } catch (e: BundleException) {
                Log.w(TAG, "Skipping a release with an unreadable $UPDATE_ASSET: ${e.message}")
            }
        }
        return found
    }

    private fun parseUpdate(text: String): UpdateManifest = try {
        val json = JSONObject(text)
        if (json.getInt("format") != 1) {
            throw BundleException("incompatible", "Update format ${json.getInt("format")} is not supported by this app")
        }
        val url = json.getString("url")
        if (!url.startsWith("https://")) throw BundleException("invalid", "The bundle URL is not https")
        UpdateManifest(
            version = json.getString("version"),
            code = json.getInt("code"),
            minHostApi = json.getInt("minHostApi"),
            url = url,
            sha256 = json.getString("sha256"),
            sig = if (json.isNull("sig")) null else json.getString("sig").takeIf { it.isNotBlank() },
            apkUrl = json.optString("apkUrl"),
        )
    } catch (e: JSONException) {
        throw BundleException("invalid", "$UPDATE_ASSET is malformed: ${e.message}")
    }

    /** The body of [url] as text, or null when it does not exist (404). Other failures throw. */
    private fun fetchText(url: String, accept: String?): String? {
        val conn = connect(url, accept)
        try {
            val status = conn.responseCode
            if (status == HTTP_NOT_FOUND) return null
            if (status !in 200..299) throw IOException("HTTP $status from ${URL(url).host}")
            val out = ByteArrayOutputStream()
            conn.inputStream.use { copyCapped(it, out, MAX_JSON_BYTES) }
            return out.toString(Charsets.UTF_8.name())
        } finally {
            conn.disconnect()
        }
    }

    /** Saves the body of [url] into [into], refusing anything over MAX_DOWNLOAD_BYTES. */
    private fun download(url: String, into: File) {
        val conn = connect(url, accept = null)
        try {
            val status = conn.responseCode
            if (status !in 200..299) throw IOException("Download failed: HTTP $status")
            if (conn.contentLengthLong > MAX_DOWNLOAD_BYTES) {
                throw IOException("The bundle is larger than ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB")
            }
            into.outputStream().use { out -> conn.inputStream.use { copyCapped(it, out, MAX_DOWNLOAD_BYTES) } }
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Opens a GET for [start], following redirects by hand so that each hop must stay on https. The returned connection
     * has its response code already read.
     */
    private fun connect(start: String, accept: String?): HttpURLConnection {
        var url = start
        for (hop in 0..MAX_REDIRECTS) {
            if (!url.startsWith("https://")) throw IOException("Refusing to fetch a non-https URL")
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.setRequestProperty("User-Agent", USER_AGENT)
            if (accept != null) conn.setRequestProperty("Accept", accept)
            val status = conn.responseCode
            if (status !in REDIRECT_CODES) return conn
            val location = conn.getHeaderField("Location")
            conn.disconnect()
            if (location == null) throw IOException("HTTP $status without a Location header")
            url = URL(URL(url), location).toString()
        }
        throw IOException("Too many redirects")
    }

    private fun copyCapped(input: InputStream, output: OutputStream, limit: Long) {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return
            total += read
            if (total > limit) throw IOException("The download is larger than ${limit / (1024 * 1024)} MB")
            output.write(buffer, 0, read)
        }
    }
}
