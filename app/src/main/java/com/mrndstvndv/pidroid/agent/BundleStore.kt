package com.mrndstvndv.pidroid.agent

import android.content.Context
import android.util.Log
import com.mrndstvndv.pidroid.BuildConfig
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

/** One installed bundle. [source] is "embedded", "ota" or "import"; [installedAt] is epoch millis. */
data class BundleInfo(
    val code: Int,
    val version: String,
    val source: String,
    val verified: Boolean,
    val installedAt: Long,
    val minHostApi: Int,
    val schemaVersion: Int,
)

/** A newer app release than this host, found by the update check; the user installs its APK. */
data class AppUpdate(val version: String, val apkUrl: String)

/** A snapshot of bundles/state.json. */
data class BundleState(
    /** The bundle the agent process runs (the last one prepare() picked). */
    val active: Int? = null,
    /** The last bundle that answered agent.ready: what a failed trial falls back to. */
    val previousGood: Int? = null,
    /** The active bundle while it has not yet answered agent.ready. */
    val trial: Int? = null,
    /** A bundle the user or the updater chose to stay on. */
    val pinned: Int? = null,
    /** Codes that failed to start; never picked again. */
    val blocked: Set<Int> = emptySet(),
    val prerelease: Boolean = false,
    val lastCheck: Long = 0,
    val lastError: String? = null,
    val appUpdate: AppUpdate? = null,
    /** The highest schemaVersion ever activated; lower ones are never activated again (except the embedded bundle). */
    val maxSchema: Int = 0,
    val bundles: Map<Int, BundleInfo> = emptyMap(),
)

/**
 * The agent bundles on the device: bundles/<code>/ (each immutable, read-only once installed), bundles/.staging/
 * (scratch for downloads and extraction) and bundles/state.json, which only this object writes.
 *
 * Which bundle runs: the pinned one if it is usable, else the highest usable code. A bundle is usable when it is not
 * blocked, its minHostApi fits this APK, its schemaVersion is not below maxSchema, and its directory exists. The
 * embedded bundle, extracted from the APK, is always there as the last fallback.
 *
 * Failures: a bundle that keeps crashing at startup is blocked and the process falls back to the last healthy bundle,
 * or to the embedded one (reportStartupFailure). A bundle that starts is healthy once it calls agent.ready (markHealthy).
 *
 * Every public function is synchronized, so the state file has one writer at a time. Functions that take a Context
 * accept any Context: they only use its application context.
 */
object BundleStore {
    private const val TAG = "BundleStore"
    private const val BUNDLES = "bundles"
    private const val STAGING = ".staging"
    private const val STATE = "state.json"
    private const val EMBEDDED_SOURCE = "embedded"
    /** Staging entries older than this are left over from a crash, not a download in progress. */
    private const val STALE_STAGING_MS = 6 * 60 * 60 * 1000L

    @Volatile
    private var embedded: BundleManifest? = null

    /**
     * Makes the layout ready and picks the bundle to run. Call before every start of the agent process.
     *  - runs the legacy migration (once), see LegacyMigration;
     *  - extracts the embedded bundle if it is new, or was reinstalled (its install time changed);
     *  - picks the bundle, and marks it as a trial when it differs from the last healthy one;
     *  - removes bundles that are no longer kept (the picked one, previousGood, pinned, embedded) and stale staging.
     * Returns the picked bundle's directory. Throws when the APK has no embedded bundle or the disk fails.
     */
    @Synchronized
    fun prepare(context: Context): File {
        val app = context.applicationContext
        LegacyMigration.migrateIfNeeded(app)
        bundlesRoot(app).mkdirs()
        val manifest = embeddedManifest(app)
        var state = ensureEmbedded(app, loadState(app), manifest)
        // Pick before collecting garbage: a bundle installed since the last start is not active yet, and is exactly the
        // one this start should pick up.
        val picked = pick(app, state, manifest.code)
        state = state.copy(
            active = picked,
            trial = picked.takeIf { it != state.previousGood },
            maxSchema = maxOf(state.maxSchema, state.bundles[picked]?.schemaVersion ?: 0),
        )
        state = collectGarbage(app, state, manifest.code)
        saveState(app, state)
        Log.i(TAG, "Running bundle $picked")
        return bundleDir(app, picked)
    }

    /** The code of the bundle the process runs, or null before the first prepare(). */
    @Synchronized
    fun activeCode(context: Context): Int? = loadState(context.applicationContext).active

    /** The running bundle answered agent.ready: it becomes the last healthy one and its trial is over. */
    @Synchronized
    fun markHealthy(context: Context) {
        val app = context.applicationContext
        val state = loadState(app)
        val active = state.active ?: return
        if (state.previousGood == active && state.trial == null) return
        saveState(app, state.copy(previousGood = active, trial = null))
        Log.i(TAG, "Bundle $active is healthy")
    }

    /**
     * The process running the active bundle failed to start repeatedly. Blocks that bundle and switches to the last
     * healthy one, or to the embedded bundle when there is no other. The next prepare() then runs the switched-to
     * bundle. Returns true when it switched, false when there is nothing else to run (the caller then keeps retrying).
     */
    @Synchronized
    fun reportStartupFailure(context: Context): Boolean {
        val app = context.applicationContext
        val state = loadState(app)
        val failing = state.active ?: return false
        val blockedState = state.copy(
            blocked = state.blocked + failing,
            pinned = state.pinned.takeIf { it != failing },
            trial = null,
        )
        val previous = state.previousGood
        val embeddedCode = embeddedManifest(app).code
        val fallback = when {
            previous != null && previous != failing && isUsable(app, blockedState, previous) -> previous
            embeddedCode != failing && bundleDir(app, embeddedCode).isDirectory -> embeddedCode
            else -> null
        }
        if (fallback == null) {
            saveState(app, blockedState.copy(lastError = "Bundle $failing failed to start and there is no other bundle to run"))
            Log.w(TAG, "Bundle $failing failed to start and there is no fallback")
            return false
        }
        saveState(app, blockedState.copy(active = fallback, lastError = "Bundle $failing failed to start and was blocked"))
        Log.w(TAG, "Bundle $failing failed to start; switched to bundle $fallback")
        return true
    }

    /**
     * Moves [staged] (a directory from BundleVerifier.verifyZip) into bundles/<code>/, makes it read-only, and records
     * it. [source] is "ota" or "import". Does not pin or activate the bundle; the caller does that. Staging of the code
     * that is already active is discarded and the existing record is returned, since the running code is not replaced.
     * Throws "incompatible" when the bundle needs a newer host.
     */
    @Synchronized
    fun install(context: Context, staged: File, source: String, verified: Boolean): BundleInfo {
        val app = context.applicationContext
        val manifest = BundleVerifier.readManifest(File(staged, "bundle.json"))
        if (manifest.minHostApi > BuildConfig.HOST_API) {
            throw BundleException("incompatible", "The bundle needs host API ${manifest.minHostApi}; this app provides ${BuildConfig.HOST_API}")
        }
        val state = loadState(app)
        val info = BundleInfo(
            code = manifest.code,
            version = manifest.version,
            source = source,
            verified = verified,
            installedAt = System.currentTimeMillis(),
            minHostApi = manifest.minHostApi,
            schemaVersion = manifest.schemaVersion,
        )
        val target = bundleDir(app, manifest.code)
        if (manifest.code == state.active && target.isDirectory) {
            staged.deleteRecursively()
            return state.bundles[manifest.code] ?: info
        }
        bundlesRoot(app).mkdirs()
        deleteTree(target)
        if (!staged.renameTo(target)) throw IOException("Could not move bundle ${manifest.code} into place")
        lockTree(target)
        saveState(app, state.copy(bundles = state.bundles + (manifest.code to info)))
        Log.i(TAG, "Installed bundle ${manifest.code} from $source")
        return info
    }

    /** Makes [code] the bundle to stay on: it must be installed. Clears a block on it. Takes effect at the next prepare(). */
    @Synchronized
    fun pin(context: Context, code: Int) {
        val app = context.applicationContext
        val state = loadState(app)
        val info = state.bundles[code] ?: throw BundleException("invalid", "Bundle $code is not installed")
        if (info.minHostApi > BuildConfig.HOST_API) {
            throw BundleException("incompatible", "Bundle $code needs host API ${info.minHostApi}; this app provides ${BuildConfig.HOST_API}")
        }
        saveState(app, state.copy(pinned = code, blocked = state.blocked - code))
    }

    /** Stops staying on a pinned bundle; the highest usable bundle is picked again. */
    @Synchronized
    fun unpin(context: Context) {
        val app = context.applicationContext
        saveState(app, loadState(app).copy(pinned = null))
    }

    @Synchronized
    fun setPrerelease(context: Context, enabled: Boolean) {
        val app = context.applicationContext
        saveState(app, loadState(app).copy(prerelease = enabled))
    }

    /** Records the time of an update check, and its error message if it failed. */
    @Synchronized
    fun recordCheck(context: Context, error: String? = null) {
        val app = context.applicationContext
        saveState(app, loadState(app).copy(lastCheck = System.currentTimeMillis(), lastError = error))
    }

    /** Records a newer app release that this host cannot run yet, or clears it with null. */
    @Synchronized
    fun setAppUpdate(context: Context, update: AppUpdate?) {
        val app = context.applicationContext
        saveState(app, loadState(app).copy(appUpdate = update))
    }

    /** A snapshot of the state file. */
    @Synchronized
    fun state(context: Context): BundleState = loadState(context.applicationContext)

    /**
     * The code prepare() would pick if the process restarted now, when it differs from the running one: a better bundle
     * is installed and waiting for a restart. Null when nothing is pending.
     */
    @Synchronized
    fun pendingActivation(context: Context): Int? {
        val app = context.applicationContext
        val state = loadState(app)
        val running = state.active ?: return null
        return pick(app, state, embeddedManifest(app).code).takeIf { it != running }
    }

    /** Where bundle [code] is installed. The directory may not exist. */
    fun bundleDir(context: Context, code: Int): File = File(bundlesRoot(context), code.toString())

    /** A new, empty scratch directory under bundles/.staging. */
    fun newStagingDir(context: Context): File =
        File(bundlesRoot(context), "$STAGING/${UUID.randomUUID()}").apply { mkdirs() }

    /** Deletes [dir] recursively, first making its directories writable so that read-only bundle contents go too. */
    internal fun deleteTree(dir: File) {
        if (!dir.exists()) return
        dir.walkTopDown().filter { it.isDirectory }.forEach { it.setWritable(true, false) }
        dir.deleteRecursively()
    }

    private fun bundlesRoot(context: Context): File = File(context.filesDir, BUNDLES)

    /** Makes every file and directory under [dir] read-only, so an installed bundle cannot be edited in place. */
    private fun lockTree(dir: File) {
        dir.walkBottomUp().forEach { it.setWritable(false, false) }
    }

    /** The embedded bundle's manifest from the APK's assets. Read once per process, since the APK does not change under it. */
    private fun embeddedManifest(context: Context): BundleManifest {
        embedded?.let { return it }
        val text = try {
            context.assets.open("agent/bundle.json").use { it.readBytes().toString(Charsets.UTF_8) }
        } catch (e: IOException) {
            throw IllegalStateException("The app has no embedded agent bundle", e)
        }
        return BundleVerifier.parseManifest(text).also { embedded = it }
    }

    /**
     * Makes sure the embedded bundle is in bundles/<code>/. It is re-extracted when the record is missing, is from another
     * source, or was installed at another time (a reinstall of the APK with the same code). Extraction goes through
     * staging and a rename, so a crash never leaves a half-written bundle under its code.
     */
    private fun ensureEmbedded(context: Context, state: BundleState, manifest: BundleManifest): BundleState {
        val installedAt = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        val existing = state.bundles[manifest.code]
        if (existing != null && existing.source == EMBEDDED_SOURCE && existing.installedAt == installedAt &&
            bundleDir(context, manifest.code).isDirectory
        ) {
            return state
        }

        val staging = newStagingDir(context)
        extractEmbedded(context, staging)
        if (!File(staging, "bundle.json").isFile) throw IllegalStateException("The embedded agent bundle has no bundle.json")
        val target = bundleDir(context, manifest.code)
        deleteTree(target)
        if (!staging.renameTo(target)) throw IOException("Could not move the embedded bundle into place")
        lockTree(target)
        Log.i(TAG, "Extracted embedded bundle ${manifest.code}")

        val info = BundleInfo(
            code = manifest.code,
            version = manifest.version,
            source = EMBEDDED_SOURCE,
            verified = true,
            installedAt = installedAt,
            minHostApi = manifest.minHostApi,
            schemaVersion = manifest.schemaVersion,
        )
        return state.copy(bundles = state.bundles + (manifest.code to info))
    }

    private fun extractEmbedded(context: Context, into: File) {
        for (path in listAssets(context, "agent", "")) {
            val target = File(into, path)
            target.parentFile?.mkdirs()
            context.assets.open("agent/$path").use { input -> target.outputStream().use { input.copyTo(it) } }
        }
    }

    /** Every file under the asset directory [assetPath], as slash-separated paths relative to [relative]'s root. */
    private fun listAssets(context: Context, assetPath: String, relative: String): List<String> {
        val children = context.assets.list(assetPath).orEmpty()
        if (children.isEmpty()) return if (relative.isEmpty()) emptyList() else listOf(relative)
        return children.flatMap { child ->
            listAssets(context, "$assetPath/$child", if (relative.isEmpty()) child else "$relative/$child")
        }
    }

    /** Whether [code] may run: installed, not blocked, compatible with this host and not below the schema floor. */
    private fun isUsable(context: Context, state: BundleState, code: Int): Boolean {
        val info = state.bundles[code] ?: return false
        return code !in state.blocked &&
            info.minHostApi <= BuildConfig.HOST_API &&
            info.schemaVersion >= state.maxSchema &&
            bundleDir(context, code).isDirectory
    }

    /** The bundle to run: the pinned one if usable, else the highest usable code, else the embedded one. */
    private fun pick(context: Context, state: BundleState, embeddedCode: Int): Int {
        val usable = state.bundles.keys.filter { isUsable(context, state, it) }
        val pinned = state.pinned
        if (pinned != null && pinned in usable) return pinned
        return usable.maxOrNull() ?: embeddedCode
    }

    /** Deletes bundle directories that are not kept, and staging left over from a crash. Returns [state] without their records. */
    private fun collectGarbage(context: Context, state: BundleState, embeddedCode: Int): BundleState {
        val root = bundlesRoot(context)
        val keep = setOfNotNull(state.active, state.previousGood, state.pinned, embeddedCode)
        for (dir in root.listFiles().orEmpty()) {
            val code = dir.name.toIntOrNull() ?: continue
            if (code !in keep) {
                Log.i(TAG, "Removing bundle $code")
                deleteTree(dir)
            }
        }
        val now = System.currentTimeMillis()
        for (dir in File(root, STAGING).listFiles().orEmpty()) {
            if (now - dir.lastModified() > STALE_STAGING_MS) deleteTree(dir)
        }
        return state.copy(bundles = state.bundles.filterKeys { it in keep })
    }

    private fun loadState(context: Context): BundleState {
        val file = File(bundlesRoot(context), STATE)
        if (!file.isFile) return BundleState()
        return try {
            parseState(JSONObject(file.readText()))
        } catch (e: JSONException) {
            Log.w(TAG, "state.json is unreadable; starting from defaults", e)
            BundleState()
        }
    }

    /** Writes state.json through a temporary file and a rename, so a crash leaves either the old or the new file. */
    private fun saveState(context: Context, state: BundleState) {
        val root = bundlesRoot(context).apply { mkdirs() }
        val tmp = File(root, "$STATE.tmp")
        FileOutputStream(tmp).use { out ->
            out.write(stateJson(state).toString(2).toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        if (!tmp.renameTo(File(root, STATE))) throw IOException("Could not write $STATE")
    }

    private fun stateJson(state: BundleState): JSONObject {
        val bundles = JSONObject()
        for ((code, info) in state.bundles) {
            bundles.put(
                code.toString(),
                JSONObject()
                    .put("source", info.source)
                    .put("verified", info.verified)
                    .put("version", info.version)
                    .put("installedAt", info.installedAt)
                    .put("minHostApi", info.minHostApi)
                    .put("schemaVersion", info.schemaVersion),
            )
        }
        val appUpdate = state.appUpdate?.let { JSONObject().put("version", it.version).put("apkUrl", it.apkUrl) }
        return JSONObject()
            .put("active", state.active ?: JSONObject.NULL)
            .put("previousGood", state.previousGood ?: JSONObject.NULL)
            .put("trial", state.trial ?: JSONObject.NULL)
            .put("pinned", state.pinned ?: JSONObject.NULL)
            .put("blocked", JSONArray(state.blocked.sorted()))
            .put("prerelease", state.prerelease)
            .put("lastCheck", state.lastCheck)
            .put("lastError", state.lastError ?: JSONObject.NULL)
            .put("appUpdate", appUpdate ?: JSONObject.NULL)
            .put("maxSchema", state.maxSchema)
            .put("bundles", bundles)
    }

    private fun parseState(json: JSONObject): BundleState {
        val bundlesJson = json.optJSONObject("bundles") ?: JSONObject()
        val bundles = bundlesJson.keys().asSequence().mapNotNull { key ->
            val code = key.toIntOrNull() ?: return@mapNotNull null
            val entry = bundlesJson.optJSONObject(key) ?: return@mapNotNull null
            code to BundleInfo(
                code = code,
                version = entry.optString("version"),
                source = entry.optString("source", "ota"),
                verified = entry.optBoolean("verified"),
                installedAt = entry.optLong("installedAt"),
                minHostApi = entry.optInt("minHostApi", 1),
                schemaVersion = entry.optInt("schemaVersion", 1),
            )
        }.toMap()
        val blockedJson = json.optJSONArray("blocked")
        val blocked = if (blockedJson == null) {
            emptySet()
        } else {
            (0 until blockedJson.length()).map { blockedJson.getInt(it) }.toSet()
        }
        val appUpdate = json.optJSONObject("appUpdate")?.let {
            AppUpdate(it.optString("version"), it.optString("apkUrl"))
        }
        return BundleState(
            active = json.optIntOrNull("active"),
            previousGood = json.optIntOrNull("previousGood"),
            trial = json.optIntOrNull("trial"),
            pinned = json.optIntOrNull("pinned"),
            blocked = blocked,
            prerelease = json.optBoolean("prerelease"),
            lastCheck = json.optLong("lastCheck"),
            lastError = if (json.isNull("lastError")) null else json.getString("lastError"),
            appUpdate = appUpdate,
            maxSchema = json.optInt("maxSchema"),
            bundles = bundles,
        )
    }

    private fun JSONObject.optIntOrNull(name: String): Int? = if (isNull(name)) null else getInt(name)
}
