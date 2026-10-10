package com.mrndstvndv.pidroid.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import androidx.core.app.NotificationCompat
import com.mrndstvndv.pidroid.MainActivity
import com.mrndstvndv.pidroid.R
import com.mrndstvndv.pidroid.agent.AgentProcessManager
import com.mrndstvndv.pidroid.bridge.AndroidBridge

class AgentForegroundService : Service() {

    companion object {
        private const val CHANNEL_ID = "pidroid_agent_channel"
        private const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.mrndstvndv.pidroid.START_AGENT"
        const val ACTION_STOP = "com.mrndstvndv.pidroid.STOP_AGENT"

        fun start(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java).apply {
                action = ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    /** Set by a stop (or the service going away) so a start still in flight on its thread backs out. */
    @Volatile
    private var stopped = false

    private val scope = CoroutineScope(Dispatchers.Main.immediate)
    private var countJob: Job? = null

    /** The count the notification shows; null until the agent first pushes one. */
    @Volatile
    private var runningCount: Int? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        // The agent pushes its running-session count over the bridge on every change (server.ts,
        // publishRunningCount); mirror it into the notification as each value lands. Nothing is polled,
        // so an idle agent costs no wakeups.
        countJob = scope.launch {
            AgentProcessManager.runningCount.collect { count ->
                // Under the lock stopCountUpdates takes, and after its stopped check, so an update can
                // never be posted once a stop has removed the notification.
                synchronized(this@AgentForegroundService) {
                    if (!stopped && count != runningCount) {
                        runningCount = count
                        runCatching {
                            getSystemService(NotificationManager::class.java)
                                ?.notify(NOTIFICATION_ID, buildNotification(statusText(count)))
                        }
                    }
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopped = true
                stopCountUpdates()
                AgentProcessManager.stopAgent()
                AndroidBridge.stop(this)
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                MainActivity.closeApp()
                return START_NOT_STICKY
            }
            ACTION_START, null -> {
                val notification = buildNotification(statusText(runningCount))
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                    } else {
                        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                    }
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }

                // Off the main thread: extraction and spawning Bun must not hold up the first frame.
                // A stop can land before this thread gets going, or while it is still starting the
                // bridge; without the checks it would then start an agent nothing is left to stop.
                stopped = false
                val appContext = applicationContext
                thread(name = "agent-start") {
                    if (stopped) return@thread
                    AndroidBridge.start(appContext)
                    AgentProcessManager.startAgent(appContext)
                    if (stopped) {
                        AgentProcessManager.stopAgent()
                        AndroidBridge.stop(appContext)
                    }
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        stopCountUpdates()
        AgentProcessManager.stopAgent()
        AndroidBridge.stop(this)
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Pidroid Agent Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the autonomous Bun agent active in background"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun stopCountUpdates() {
        synchronized(this) {
            countJob?.cancel()
            countJob = null
            runningCount = null
        }
    }

    private fun statusText(count: Int?): String = when (count) {
        null -> "Starting agent..."
        1 -> "1 agent running"
        else -> "$count agents running"
    }

    private fun buildNotification(status: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, AgentForegroundService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Pidroid Autonomous Agent")
            .setContentText(status)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .addAction(0, "Stop agent", stopIntent)
            .build()
    }
}
