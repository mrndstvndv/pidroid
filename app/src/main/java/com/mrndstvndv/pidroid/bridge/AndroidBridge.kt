package com.mrndstvndv.pidroid.bridge

import android.content.Context
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import android.system.Os
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

/**
 * Lets the Bun agent call Android APIs. Bun connects to a Unix socket in filesDir and sends one JSON line
 * `{"method": "...", "args": {...}}`; this replies with one line `{"ok": true, "result": ...}` or
 * `{"ok": false, "error": "...", "code": "..."}` and closes. Nothing runs while no call is in flight.
 *
 * Access control lives here, not in the agent's (editable) TypeScript: the socket file is 0600 and every
 * connection's peer UID must be this app's. Capabilities are a fixed Kotlin registry, so the agent can only
 * reach what is registered below.
 */
object AndroidBridge {
    private const val TAG = "AndroidBridge"
    private const val SOCKET_NAME = "bridge.sock"
    private const val MAX_REQUEST_BYTES = 256 * 1024

    private var server: LocalServerSocket? = null
    // LocalServerSocket(fd) borrows this socket's descriptor; if it is collected, its finalizer closes the fd under the server.
    private var bound: LocalSocket? = null
    private var scope: CoroutineScope? = null

    fun socketPath(context: Context): String = File(context.filesDir, SOCKET_NAME).absolutePath

    @Synchronized
    fun start(context: Context) {
        if (server != null) return
        val appContext = context.applicationContext
        val path = socketPath(appContext)
        try {
            File(path).delete()
            // A filesystem socket (rather than the abstract namespace) so permissions apply and Bun can address it by path.
            val sock = LocalSocket().apply { bind(LocalSocketAddress(path, LocalSocketAddress.Namespace.FILESYSTEM)) }
            bound = sock
            Os.chmod(path, 384) // 0600
            val srv = LocalServerSocket(sock.fileDescriptor)
            server = srv
            val s = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            scope = s
            s.launch {
                while (true) {
                    val client = try { srv.accept() } catch (e: Exception) { break }
                    launch { client.use { handle(appContext, it) } }
                }
            }
            Log.d(TAG, "Listening on $path")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start bridge", e)
            server = null
            runCatching { bound?.close() }
            bound = null
        }
    }

    @Synchronized
    fun stop(context: Context) {
        runCatching { server?.close() }
        runCatching { bound?.close() }
        server = null
        bound = null
        scope?.cancel()
        scope = null
        File(socketPath(context)).delete()
    }

    private fun handle(context: Context, client: LocalSocket) {
        val reply = try {
            if (client.peerCredentials.uid != Process.myUid()) {
                error("forbidden", "Caller is not this app")
            } else {
                val line = readLine(client)
                val req = JSONObject(line)
                val method = req.optString("method")
                val handler = Capabilities.handlers[method] ?: return client.reply(error("unknown_method", "No such method: $method"))
                try {
                    JSONObject().put("ok", true).put("result", handler(context, req.optJSONObject("args") ?: JSONObject()))
                } catch (e: BridgeException) {
                    error(e.code, e.message ?: e.code)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Bridge call failed", e)
            error("internal", e.message ?: e.javaClass.simpleName)
        }
        client.reply(reply)
    }

    /** Reads up to the first newline (or EOF) without buffering past MAX_REQUEST_BYTES. */
    private fun readLine(client: LocalSocket): String {
        val out = java.io.ByteArrayOutputStream()
        val input = client.inputStream
        while (out.size() < MAX_REQUEST_BYTES) {
            val b = input.read()
            if (b < 0 || b == '\n'.code) break
            out.write(b)
        }
        return out.toString(Charsets.UTF_8.name())
    }

    private fun LocalSocket.reply(json: JSONObject) {
        outputStream.write((json.toString() + "\n").toByteArray(Charsets.UTF_8))
        outputStream.flush()
    }

    private fun error(code: String, message: String) =
        JSONObject().put("ok", false).put("code", code).put("error", message)
}

/** A failure the agent should see as a normal tool error, with a stable `code` it can branch on. */
class BridgeException(val code: String, message: String) : Exception(message)
