package com.mrndstvndv.pidroid.bridge

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.mrndstvndv.pidroid.BuildConfig
import com.mrndstvndv.pidroid.MainActivity
import com.mrndstvndv.pidroid.R
import com.mrndstvndv.pidroid.agent.AgentProcessManager
import com.mrndstvndv.pidroid.agent.BundleException
import com.mrndstvndv.pidroid.agent.BundleStore
import com.mrndstvndv.pidroid.agent.BundleUpdater
import com.mrndstvndv.pidroid.agent.BundleVerifier
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/** The fixed set of Android features the agent can reach. Add one here and a tool wrapper in extensions/android.ts. */
object Capabilities {
    val handlers: Map<String, (Context, JSONObject) -> Any?> = mapOf(
        "battery.get" to ::battery,
        "notification.post" to ::postNotification,
        "agent.setRunningCount" to ::setRunningCount,
        "agent.ready" to ::agentReady,
        "bundle.status" to ::bundleStatus,
        "bundle.check" to ::bundleCheck,
        "bundle.setPrerelease" to ::bundleSetPrerelease,
        "bundle.install" to ::bundleInstall,
        "bundle.activate" to ::bundleActivate,
        "bundle.unpin" to ::bundleUnpin,
    )

    private const val CHANNEL_ID = "pidroid_agent_messages"
    private const val FIRST_ID = 2000
    private val nextId = AtomicInteger(FIRST_ID)

    private fun battery(context: Context, @Suppress("UNUSED_PARAMETER") args: JSONObject): JSONObject {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: throw BridgeException("unavailable", "Battery state is unavailable")
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val plug = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        return JSONObject()
            .put("percent", if (level >= 0 && scale > 0) level * 100 / scale else JSONObject.NULL)
            .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
            .put("plugged", when {
                plug and BatteryManager.BATTERY_PLUGGED_AC != 0 -> "ac"
                plug and BatteryManager.BATTERY_PLUGGED_USB != 0 -> "usb"
                plug and BatteryManager.BATTERY_PLUGGED_WIRELESS != 0 -> "wireless"
                else -> "none"
            })
            .put("temperatureC", intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0)
    }

    /**
     * The agent pushes its running-session count here on every change (server.ts, publishRunningCount),
     * which is what lets the foreground-service notification follow a run without polling. There is no
     * tool wrapper for it in extensions/android.ts: this is a status the host is told, not one the agent
     * asks for.
     */
    private fun setRunningCount(context: Context, @Suppress("UNUSED_PARAMETER") args: JSONObject): JSONObject {
        AgentProcessManager.setRunningCount(args.optInt("running", 0))
        return JSONObject()
    }

    /**
     * The agent (server.ts) calls this once, about 5s after it starts listening, to say the bundle it runs came up: the
     * bundle is then the last healthy one (BundleStore.markHealthy). A failed start never gets here.
     */
    private fun agentReady(context: Context, @Suppress("UNUSED_PARAMETER") args: JSONObject): JSONObject {
        BundleStore.markHealthy(context)
        return JSONObject()
    }

    /** The Updates tab's view of the bundles: the shape www/updates-tab.js renders (see the server's /api/bundles routes). */
    private fun bundleStatus(context: Context, @Suppress("UNUSED_PARAMETER") args: JSONObject): JSONObject {
        val state = BundleStore.state(context)
        val active = state.active?.let { state.bundles[it] }
        val activeJson = JSONObject()
            .put("code", state.active ?: JSONObject.NULL)
            .put("version", active?.version ?: JSONObject.NULL)
            .put("source", active?.source ?: JSONObject.NULL)
            .put("verified", active?.verified ?: false)
        val bundles = JSONArray()
        for (info in state.bundles.values.sortedBy { it.code }) {
            bundles.put(
                JSONObject()
                    .put("code", info.code)
                    .put("version", info.version)
                    .put("source", info.source)
                    .put("verified", info.verified)
                    .put("active", info.code == state.active)
                    .put("pinned", info.code == state.pinned)
                    .put("blocked", info.code in state.blocked),
            )
        }
        val pendingCode = BundleStore.pendingActivation(context)
        val pending = if (pendingCode == null) {
            JSONObject.NULL
        } else {
            JSONObject().put("code", pendingCode).put("version", state.bundles[pendingCode]?.version ?: JSONObject.NULL)
        }
        val appUpdate = state.appUpdate?.let { JSONObject().put("version", it.version).put("apkUrl", it.apkUrl) }
        return JSONObject()
            .put("active", activeJson)
            .put("bundles", bundles)
            .put("pinned", state.pinned ?: JSONObject.NULL)
            .put("prerelease", state.prerelease)
            .put("lastCheck", state.lastCheck)
            .put("lastError", state.lastError ?: JSONObject.NULL)
            .put("checking", BundleUpdater.isChecking)
            .put("pending", pending)
            .put("appUpdate", appUpdate ?: JSONObject.NULL)
            .put("hostApi", BuildConfig.HOST_API)
    }

    /** Starts a check now; the status it returns says checking=true, and the page polls until it ends. */
    private fun bundleCheck(context: Context, args: JSONObject): JSONObject {
        BundleUpdater.check(context, force = true)
        return bundleStatus(context, args)
    }

    private fun bundleSetPrerelease(context: Context, args: JSONObject): JSONObject {
        BundleStore.setPrerelease(context, args.optBoolean("enabled"))
        BundleUpdater.check(context, force = true)
        return bundleStatus(context, args)
    }

    /**
     * Installs a zip the server stored in data/inbox, pins it and applies it when the agent is idle. Only a file in the inbox
     * is accepted. A bundle is unverified (and refused) unless [signature] (base64) signs it with the release key, or the
     * caller passes allowUnverified after the user has confirmed it.
     */
    private fun bundleInstall(context: Context, args: JSONObject): JSONObject {
        val file = inboxZip(context, args.optString("path"))
        val signature = args.optString("signature").takeIf { it.isNotBlank() }
        val allowUnverified = args.optBoolean("allowUnverified")
        val info = bundleErrors {
            val verified = BundleVerifier.verifyZip(context, file, expectedSha256 = null, signatureB64 = signature, allowUnverified = allowUnverified)
            BundleStore.install(context, verified.dir, "import", verified.verified)
        }
        bundleErrors { BundleStore.pin(context, info.code) }
        restartIfPending(context)
        return JSONObject().put("code", info.code).put("version", info.version).put("verified", info.verified)
    }

    /** Switches to an installed bundle: pins it, and the agent restarts with it once idle. */
    private fun bundleActivate(context: Context, args: JSONObject): JSONObject {
        bundleErrors { BundleStore.pin(context, args.optInt("code", -1)) }
        restartIfPending(context)
        return bundleStatus(context, args)
    }

    /** Back to the latest bundle: unpins, checks for updates, and restarts if a different bundle is ready. */
    private fun bundleUnpin(context: Context, args: JSONObject): JSONObject {
        BundleStore.unpin(context)
        BundleUpdater.check(context, force = true)
        restartIfPending(context)
        return bundleStatus(context, args)
    }

    private fun restartIfPending(context: Context) {
        if (BundleStore.pendingActivation(context) != null) AgentProcessManager.restartWhenIdle(context)
    }

    /** Turns a BundleException into the BridgeException the agent sees, with the same code. */
    private inline fun <T> bundleErrors(block: () -> T): T =
        try {
            block()
        } catch (e: BundleException) {
            throw BridgeException(e.code, e.message ?: e.code)
        }

    private fun inboxZip(context: Context, path: String): File {
        if (path.isBlank()) throw BridgeException("bad_args", "path is required")
        val inbox = File(context.filesDir, "data/inbox").canonicalFile
        val file = File(path).canonicalFile
        if (!file.isFile || !file.path.startsWith(inbox.path + File.separator)) {
            throw BridgeException("invalid", "The bundle must be a file in the app's inbox")
        }
        return file
    }

    private fun postNotification(context: Context, args: JSONObject): JSONObject {
        val title = args.optString("title").takeIf { it.isNotBlank() }
            ?: throw BridgeException("bad_args", "title is required")
        val id = if (args.has("id")) args.optInt("id") else null
        val notificationId = showNotification(context, title, args.optString("body"), id)
        return JSONObject().put("id", notificationId)
    }

    /**
     * Posts a notification that opens the app when tapped. [id] replaces an earlier notification with that id; null takes
     * the next free id. Throws BridgeException when the user has notifications off for the app.
     */
    fun showNotification(context: Context, title: String, body: String, id: Int? = null): Int {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            throw BridgeException("needs_permission", "Notification permission is not granted; the user must allow it in Android settings")
        }
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            throw BridgeException("needs_permission", "Notifications are turned off for Pidroid in Android settings")
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Agent messages", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Notifications the agent sends you"
                }
            )
        }

        // Reusing a caller-chosen id replaces the earlier notification (e.g. progress updates).
        val notificationId = id ?: nextId.getAndUpdate { if (it == Int.MAX_VALUE) FIRST_ID else it + 1 }
        val open = PendingIntent.getActivity(
            context, notificationId, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        @Suppress("MissingPermission") // checked above
        NotificationManagerCompat.from(context).notify(notificationId, notification)
        return notificationId
    }
}
