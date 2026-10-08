package com.mrndstvndv.pidroid.agent

import android.content.Context
import android.system.Os
import android.util.Log
import com.mrndstvndv.pidroid.bridge.AndroidBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * PRIMARY runs the (agent-editable) server.ts. SAFE runs the shipped bundle (the recovery server): after repeated startup
 * failures, and while an app update waits for the server to reconcile it with the agent's files (see AssetExtractor).
 */
enum class AgentMode { PRIMARY, SAFE }

object AgentProcessManager {
    private const val TAG = "AgentProcessManager"
    const val SERVER_PORT = 8765

    private var process: Process? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    private val _isRunning = MutableStateFlow(false)
    val isRunning: StateFlow<Boolean> = _isRunning.asStateFlow()

    private val _mode = MutableStateFlow(AgentMode.PRIMARY)
    val mode: StateFlow<AgentMode> = _mode.asStateFlow()

    /** The server exits with this code to ask for an immediate relaunch (restart_server); anything else is a crash. */
    private const val PLANNED_EXIT_CODE = 75
    private const val FAST_EXIT_MS = 20_000L
    private const val FAST_FAILURES_BEFORE_SAFE_MODE = 3
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
            val agentDir = AssetExtractor.extractAgentAssets(context)
            val nativeDir = context.applicationInfo.nativeLibraryDir
            val bunBinary = File(nativeDir, "libbun.so")

            if (!bunBinary.exists()) {
                appendLog("[ERROR] libbun.so not found at ${bunBinary.absolutePath}")
                return false
            }

            // Primary: the editable TypeScript source, with dependencies prebuilt in vendor/ (see tsconfig.json paths).
            // Safe mode: a full bundle of the shipped server, built by bundleAgent. It runs after repeated startup failures,
            // and while an app update waits to be reconciled: the agent's own server does not yet hold the update's files.
            val useRecovery = _mode.value == AgentMode.SAFE || AssetExtractor.updatePending(context)
            val serverScript = if (useRecovery) File(agentDir, "fallback/server.js") else File(agentDir, "server.ts")
            if (!serverScript.exists()) {
                appendLog("[ERROR] ${serverScript.absolutePath} not found")
                return false
            }
            startedAt = System.currentTimeMillis()
            appendLog("[INFO] Spawning Bun runtime: ${bunBinary.absolutePath} run ${serverScript.absolutePath}")

            val processBuilder = ProcessBuilder(
                bunBinary.absolutePath,
                "run",
                serverScript.absolutePath
            ).apply {
                directory(agentDir)
                environment()["PORT"] = SERVER_PORT.toString()
                environment()["TMPDIR"] = context.cacheDir.absolutePath
                environment()["HOME"] = context.filesDir.absolutePath
                // The recovery server serves the shipped web UI from the staged bundle (see server.ts WWW_DIR).
                if (useRecovery) environment()["PIDROID_RECOVERY"] = "1"
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
            appendLog("[INFO] Agent process stopped by request.")
        }
    }

    private val crashTimes = ArrayDeque<Long>()

    /**
     * Bun exited without the app asking it to stop.
     *  - Exit code 75: a planned restart (restart_server); relaunch at once.
     *  - Otherwise a crash: relaunch after 2s. Three crashes in a row within seconds of starting mean the (edited)
     *    server can't start, so switch to the shipped safe-mode server; the user can then undo the edit from the
     *    Changes tab and tap Restart. Give up after repeated crashes so a poisoned run can't spin forever.
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
        if (fastFailures >= FAST_FAILURES_BEFORE_SAFE_MODE && _mode.value == AgentMode.PRIMARY) {
            appendLog("[ERROR] The server failed to start $fastFailures times in a row; falling back to the shipped safe-mode server. Undo the last change in the Changes tab, then tap Restart.")
            _mode.value = AgentMode.SAFE
            fastFailures = 0
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

    /** User-initiated restart: leaves safe mode and tries the editable server again. */
    fun restart(context: Context) {
        scope.launch {
            val old = process
            stopAgent()
            old?.waitFor(5, TimeUnit.SECONDS)
            synchronized(crashTimes) { crashTimes.clear() }
            fastFailures = 0
            _mode.value = AgentMode.PRIMARY
            startAgent(context.applicationContext)
        }
    }

    /** Ask the running agent to undo its newest change. Returns a short message for the user. */
    suspend fun undoLatestChange(): String = withContext(Dispatchers.IO) {
        runCatching {
            val conn = URL("http://127.0.0.1:$SERVER_PORT/api/changes/undo-latest").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 3000
            conn.readTimeout = 15000
            val text = (if (conn.responseCode < 400) conn.inputStream else conn.errorStream).bufferedReader().readText()
            val json = JSONObject(text)
            when {
                json.has("error") -> "Undo failed: ${json.getString("error")}"
                json.getJSONArray("reverted").length() == 0 -> "Nothing to undo"
                else -> "Reverted ${json.getJSONArray("reverted").length()} file(s)"
            }
        }.getOrElse { "Agent not reachable: ${it.message}" }
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
