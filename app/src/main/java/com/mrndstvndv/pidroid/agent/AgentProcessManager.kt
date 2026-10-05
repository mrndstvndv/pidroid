package com.mrndstvndv.pidroid.agent

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader

object AgentProcessManager {
    private const val TAG = "AgentProcessManager"
    const val SERVER_PORT = 8765

    private var process: Process? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    private val _isRunning = MutableStateFlow(false)
    val isRunning: StateFlow<Boolean> = _isRunning.asStateFlow()

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

            val serverScript = File(agentDir, "server.ts")
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
                redirectErrorStream(true)
            }

            val proc = processBuilder.start()
            process = proc
            _isRunning.value = true

            scope.launch {
                BufferedReader(InputStreamReader(proc.inputStream)).use { reader ->
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        line?.let {
                            Log.d(TAG, "[Bun] $it")
                            appendLog(it)
                        }
                    }
                }
                val exitCode = proc.waitFor()
                Log.d(TAG, "Bun process exited with code $exitCode")
                appendLog("[INFO] Bun process stopped with exit code $exitCode")
                _isRunning.value = false
                process = null
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

    private fun appendLog(line: String) {
        val current = _logs.value.toMutableList()
        if (current.size > 200) current.removeAt(0)
        current.add(line)
        _logs.value = current
    }
}
