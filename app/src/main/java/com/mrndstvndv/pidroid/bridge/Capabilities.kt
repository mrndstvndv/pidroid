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
import com.mrndstvndv.pidroid.MainActivity
import com.mrndstvndv.pidroid.R
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/** The fixed set of Android features the agent can reach. Add one here and a tool wrapper in extensions/android.ts. */
object Capabilities {
    val handlers: Map<String, (Context, JSONObject) -> Any?> = mapOf(
        "battery.get" to ::battery,
        "notification.post" to ::postNotification,
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

    private fun postNotification(context: Context, args: JSONObject): JSONObject {
        val title = args.optString("title").takeIf { it.isNotBlank() }
            ?: throw BridgeException("bad_args", "title is required")
        val body = args.optString("body")

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
        val id = if (args.has("id")) args.optInt("id") else nextId.getAndUpdate { if (it == Int.MAX_VALUE) FIRST_ID else it + 1 }
        val open = PendingIntent.getActivity(
            context, id, Intent(context, MainActivity::class.java),
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
        NotificationManagerCompat.from(context).notify(id, notification)
        return JSONObject().put("id", id)
    }
}
