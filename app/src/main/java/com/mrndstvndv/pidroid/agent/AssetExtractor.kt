package com.mrndstvndv.pidroid.agent

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** What to do with a file the agent edited that the app update also changed. */
enum class ConflictChoice { KEEP_AGENT, USE_SHIPPED }

data class ExtractResult(
    val dir: File,
    /** Files edited by the agent AND changed by the update. Nothing was written while this is non-empty. */
    val conflicts: List<String> = emptyList(),
)

/**
 * Copies the bundled agent files to filesDir/agent.
 *
 * `.shipped_manifest.json` records the hash of every file as last shipped, which tells an agent edit
 * (current != last shipped) apart from an untouched file. On an app update:
 *  - untouched files are overwritten,
 *  - agent-edited files the update did not change are kept,
 *  - agent-edited files the update also changed are a conflict, resolved by [ConflictChoice].
 *
 * The agent's server checkpoints the directory to git at startup, so whichever side loses stays in history.
 */
object AssetExtractor {
    private const val TAG = "AssetExtractor"
    private const val ROOT = "agent"
    private const val MANIFEST = ".shipped_manifest.json"

    fun extractAgentAssets(
        context: Context,
        choice: ConflictChoice? = null,
        /** Overwrite every shipped file and drop extra files under www/ ("reset UI to shipped version"). */
        force: Boolean = false,
    ): ExtractResult {
        val targetDir = File(context.filesDir, ROOT)
        val manifestFile = File(targetDir, MANIFEST)

        val shipped = listAssets(context, ROOT, "").associateWith { sha256(context.assets.open("$ROOT/$it").readBytes()) }
        val previous = readManifest(manifestFile)

        // Same shipped files as last time: nothing to do (an app update changes the hashes, so no manual version bump).
        if (!force && targetDir.exists() && previous == shipped) {
            Log.d(TAG, "Agent assets already up-to-date at ${targetDir.absolutePath}")
            return ExtractResult(targetDir)
        }

        // Plan first so a conflict writes nothing.
        val write = mutableListOf<String>()
        val conflicts = mutableListOf<String>()
        for ((path, shippedHash) in shipped) {
            val target = File(targetDir, path)
            if (force || !target.exists()) {
                write += path
                continue
            }
            val currentHash = sha256(target.readBytes())
            val lastShipped = previous[path]
            when {
                currentHash == shippedHash -> Unit
                lastShipped == null || currentHash == lastShipped -> write += path // untouched (or pre-manifest install)
                shippedHash == lastShipped -> Unit // agent edit, update didn't touch the file: keep
                else -> conflicts += path
            }
        }

        if (conflicts.isNotEmpty() && choice == null) {
            Log.d(TAG, "Update conflicts with agent edits: $conflicts")
            return ExtractResult(targetDir, conflicts.sorted())
        }
        if (choice == ConflictChoice.USE_SHIPPED) write += conflicts

        Log.d(TAG, "Extracting ${write.size} agent files to ${targetDir.absolutePath} (force=$force)")
        targetDir.mkdirs()
        for (path in write) {
            val target = File(targetDir, path)
            target.parentFile?.mkdirs()
            context.assets.open("$ROOT/$path").use { input -> target.outputStream().use { input.copyTo(it) } }
        }
        if (force) {
            File(targetDir, "www").walkBottomUp().filter { it.isFile }.forEach { file ->
                if (file.relativeTo(targetDir).invariantSeparatorsPath !in shipped) file.delete()
            }
        }

        // Generated, never agent-edited: drop files from older builds (vendor chunks are content-hashed) and the legacy bundle.
        for (generated in listOf("vendor", "fallback")) {
            File(targetDir, generated).walkBottomUp().filter { it.isFile }.forEach { file ->
                if (file.relativeTo(targetDir).invariantSeparatorsPath !in shipped) file.delete()
            }
        }
        File(targetDir, "server.js").delete()

        // Kept agent edits stay "modified" relative to the new shipped base, so later updates still see them.
        writeManifest(manifestFile, shipped)
        return ExtractResult(targetDir)
    }

    private fun listAssets(context: Context, assetPath: String, relative: String): List<String> {
        val children = context.assets.list(assetPath).orEmpty()
        if (children.isEmpty()) return if (relative.isEmpty()) emptyList() else listOf(relative)
        return children.flatMap { child ->
            listAssets(context, "$assetPath/$child", if (relative.isEmpty()) child else "$relative/$child")
        }
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun readManifest(file: File): Map<String, String> {
        if (!file.exists()) return emptyMap()
        return runCatching {
            val json = JSONObject(file.readText())
            json.keys().asSequence().associateWith { json.getString(it) }
        }.getOrDefault(emptyMap())
    }

    private fun writeManifest(file: File, hashes: Map<String, String>) {
        file.writeText(JSONObject(hashes).toString())
    }
}
