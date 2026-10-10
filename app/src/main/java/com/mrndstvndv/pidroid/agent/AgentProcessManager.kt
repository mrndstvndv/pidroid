package com.mrndstvndv.pidroid.agent

import android.content.Context
import android.system.Os
import android.util.Log
import com.mrndstvndv.pidroid.bridge.AndroidBridge
import com.mrndstvndv.pidroid.bridge.Capabilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit

/**
 * Runs the agent: the active bundle's server.ts under Bun, restarted when it exits. The bundle is chosen by BundleStore
 * (see there); this class only starts, watches and restarts the process.
 */
object AgentProcessManager {
    private const val TAG = "AgentProcessManager"
    const val SERVER_PORT = 8765

    private var process: Process? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    private val _isRunning = MutableStateFlow(false)
    val isRunning: StateFlow<Boolean> = _isRunning.asStateFlow()

    /** The agent's pushed count of sessions with a run in flight; null until this process's first push. */
    private val _runningCount = MutableStateFlow<Int?>(null)
    val runningCount: StateFlow<Int?> = _runningCount.asStateFlow()

    /** The server exits with this code to ask for an immediate relaunch (restart_server); anything else is a crash. */
    private const val PLANNED_EXIT_CODE = 75
    private const val FAST_EXIT_MS = 20_000L
    /** Consecutive starts that die within FAST_EXIT_MS before the active bundle is blocked and the host falls back. */
    private const val FAST_FAILURES_BEFORE_ROLLBACK = 3
    private var startedAt = 0L
    private var fastFailures = 0

    private val _logs = MutableStateFlow<List<String>>(emptyList())
    val logs: StateFlow<List<String>> = _logs.asStateFlow()

    @Synchronized
    fun startAgent(context: Context): Boolean {
        if (process != null && process?.isAlive == true) {
            Log.d(TAG, "Agent process already running.")
            return true
        }

        try {
            val bundleDir = BundleStore.prepare(context)
            val bundleCode = BundleStore.activeCode(context) ?: throw IllegalStateException("No agent bundle is active")
            val dataDir = File(context.filesDir, "data")
            val nativeDir = context.applicationInfo.nativeLibraryDir
            val bunBinary = File(nativeDir, "libbun.so")

            if (!bunBinary.exists()) {
                appendLog("[ERROR] libbun.so not found at ${bunBinary.absolutePath}")
                return false
            }

            val serverScript = File(bundleDir, "server.ts")
            if (!serverScript.exists()) {
                appendLog("[ERROR] ${serverScript.absolutePath} not found")
                return false
            }
            startedAt = System.currentTimeMillis()
            appendLog("[INFO] Spawning Bun runtime: ${bunBinary.absolutePath} run ${serverScript.absolutePath} (bundle $bundleCode)")

            val processBuilder = ProcessBuilder(
                bunBinary.absolutePath,
                "run",
                serverScript.absolutePath
            ).apply {
                directory(bundleDir)
                environment()["PORT"] = SERVER_PORT.toString()
                environment()["TMPDIR"] = context.cacheDir.absolutePath
                environment()["HOME"] = context.filesDir.absolutePath
                // The server derives every path from these (paths.ts): the read-only bundle, the app's state and its files.
                environment()["PIDROID_APP_DIR"] = bundleDir.absolutePath
                environment()["PIDROID_DATA_DIR"] = dataDir.absolutePath
                environment()["PIDROID_HOME"] = context.filesDir.absolutePath
                environment()["PIDROID_BUNDLE_CODE"] = bundleCode.toString()
                environment()["PIDROID_BRIDGE_SOCKET"] = AndroidBridge.socketPath(context)
                // bun / bunx / ssh / ssh-keygen on PATH: the agent's bash tool can run scripts and install packages with
                // Bun, and pi-env finds the OpenSSH client (from Termux, packaged as native libs) by name.
                prepareTools(context)?.let { bin ->
                    environment()["PATH"] = bin + ":" + (environment()["PATH"] ?: "/system/bin:/system/xbin")
                }
                redirectErrorStream(true)
            }

            val proc = processBuilder.start()
            process = proc
            _isRunning.value = true
            // A fresh process pushes its own count; until it does, the notification says "Starting agent...".
            _runningCount.value = null

            scope.launch {
                // Reading can throw when the process dies or is destroyed (e.g. Android's phantom-process killer);
                // that must never take the app down.
                runCatching {
                    BufferedReader(InputStreamReader(proc.inputStream)).use { reader ->
                        var line: String?
                        while (reader.readLine().also { line = it } != null) {
                            line?.let {
                                Log.d(TAG, "[Bun] $it")
                                appendLog(it)
                            }
                        }
                    }
                }.onFailure { Log.w(TAG, "Bun output stream closed: ${it.message}") }

                val exitCode = runCatching { proc.waitFor() }.getOrDefault(-1)
                Log.d(TAG, "Bun process exited with code $exitCode")
                appendLog("[INFO] Bun process stopped with exit code $exitCode")

                // A restart may already have replaced this process; don't clobber the new one's state.
                val unexpected = synchronized(this@AgentProcessManager) {
                    if (process === proc) {
                        _isRunning.value = false
                        _runningCount.value = null
                        process = null
                        true
                    } else {
                        false
                    }
                }
                if (unexpected) onUnexpectedExit(context.applicationContext, exitCode, System.currentTimeMillis() - startedAt)
            }

            return true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start agent process", e)
            appendLog("[ERROR] Exception: ${e.message}")
            _isRunning.value = false
            return false
        }
    }

    @Synchronized
    fun stopAgent() {
        process?.let {
            it.destroy()
            process = null
            _isRunning.value = false
            _runningCount.value = null
            appendLog("[INFO] Agent process stopped by request.")
        }
    }

    private val crashTimes = ArrayDeque<Long>()

    /**
     * Bun exited without the app asking it to stop.
     *  - Exit code 75: a planned restart (restart_server); relaunch at once.
     *  - Otherwise a crash: relaunch after 2s. Three crashes in a row within seconds of starting block the active bundle
     *    and switch to the last healthy one (BundleStore.reportStartupFailure). Give up after repeated crashes so a
     *    poisoned run can't spin forever.
     */
    private suspend fun onUnexpectedExit(context: Context, exitCode: Int, livedMs: Long) {
        if (exitCode == PLANNED_EXIT_CODE) {
            appendLog("[INFO] Agent requested a restart")
            delay(300)
            startAgent(context)
            return
        }

        val now = System.currentTimeMillis()
        fastFailures = if (livedMs < FAST_EXIT_MS) fastFailures + 1 else 0
        if (fastFailures >= FAST_FAILURES_BEFORE_ROLLBACK) {
            fastFailures = 0
            val failed = BundleStore.activeCode(context)
            if (BundleStore.reportStartupFailure(context)) {
                val fallback = BundleStore.activeCode(context)
                appendLog("[ERROR] Bundle $failed failed to start $FAST_FAILURES_BEFORE_ROLLBACK times in a row; blocked it and switched to bundle $fallback.")
                runCatching {
                    Capabilities.showNotification(
                        context,
                        "Agent update rolled back",
                        "The new agent (bundle $failed) failed to start, so the app is running bundle $fallback.",
                    )
                }.onFailure { appendLog("[WARN] Could not post the rollback notification: ${it.message}") }
            } else {
                appendLog("[ERROR] Bundle $failed failed to start $FAST_FAILURES_BEFORE_ROLLBACK times in a row and there is no other bundle to run.")
            }
        }

        synchronized(crashTimes) {
            crashTimes.addLast(now)
            while (crashTimes.isNotEmpty() && now - crashTimes.first() > 120_000) crashTimes.removeFirst()
            if (crashTimes.size > 8) {
                appendLog("[ERROR] Agent crashed ${crashTimes.size} times in 2 minutes; not restarting. Tap Restart to try again.")
                return
            }
        }
        appendLog("[INFO] Agent stopped unexpectedly (exit $exitCode); restarting in 2s")
        delay(2000)
        startAgent(context)
    }

    /** User-initiated restart: stops the process and starts it again, with the bundle BundleStore picks now. */
    fun restart(context: Context) {
        scope.launch {
            val old = process
            stopAgent()
            old?.waitFor(5, TimeUnit.SECONDS)
            synchronized(crashTimes) { crashTimes.clear() }
            fastFailures = 0
            startAgent(context.applicationContext)
        }
    }

    /**
     * Restarts the agent once no session has a run in flight, so an update never cuts a run off. Idle means the count is 0,
     * or there is no count and no process (nothing has started, or it has stopped).
     */
    fun restartWhenIdle(context: Context) {
        val appContext = context.applicationContext
        scope.launch {
            combine(runningCount, isRunning) { count, running -> count == 0 || (count == null && !running) }.first { it }
            restart(appContext)
        }
    }

    /**
     * The agent pushes its running-session count over the bridge whenever it changes (server.ts,
     * publishRunningCount), so the notification can follow a run starting or ending without polling
     * the agent: an idle agent makes no calls at all.
     */
    fun setRunningCount(count: Int) {
        _runningCount.value = count
    }

    /**
     * Command-line tools the agent's shell (and pi-env) expect by name. Android only lets an app execute files from its
     * native library directory, where they live as lib*.so (libbun.so is the complete Bun CLI; libopenssh_*.so is
     * OpenSSH; libgrep.so is GNU grep). Link them under their real names into filesDir/bin, which the caller puts on
     * PATH. The link target moves with every install, so the links are recreated on each start. Returns that directory,
     * or null if no tool could be linked.
     *
     * `bunx` is the same binary: Bun switches to its `x` mode when started under that name. `egrep` and `fgrep` are
     * libgrep.so too: grep switches to -E or -F when started under that name.
     */
    private fun prepareTools(context: Context): String? {
        val nativeDir = File(context.applicationInfo.nativeLibraryDir)
        val bin = File(context.filesDir, "bin").apply { mkdirs() }
        val tools = mapOf(
            "bun" to "libbun.so",
            "bunx" to "libbun.so",
            "ssh" to "libopenssh_ssh.so",
            "ssh-keygen" to "libopenssh_keygen.so",
            "grep" to "libgrep.so",
            "egrep" to "libgrep.so",
            "fgrep" to "libgrep.so",
        )
        var linked = 0
        for ((name, lib) in tools) {
            val target = File(nativeDir, lib)
            if (!target.exists()) continue
            val link = File(bin, name)
            link.delete()
            runCatching { Os.symlink(target.absolutePath, link.absolutePath); linked++ }
                .onFailure { appendLog("[WARN] Could not link $name: ${it.message}") }
        }
        return if (linked > 0) bin.absolutePath else null
    }

    private fun appendLog(line: String) {
        val current = _logs.value.toMutableList()
        if (current.size > 200) current.removeAt(0)
        current.add(line)
        _logs.value = current
    }
}
