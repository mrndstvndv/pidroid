package com.mrndstvndv.pidroid.agent

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * Puts the bundled agent files where the agent runs them.
 *
 * First install: the whole bundle is copied into filesDir/agent, which is then the agent's shipped baseline. Every
 * install after that (an app update) only stages the bundle in filesDir/agent-bundle and replaces the generated trees
 * (vendor/, fallback/) in place. The server reconciles the staged bundle with the agent's own files (changes.ts): files
 * the agent has not touched take the update, and a file both sides changed waits for the user's choice in the Changes
 * tab. Until the server records the bundle as applied (.applied_stamp), [updatePending] is true and the recovery
 * server, which is the shipped bundle itself, runs.
 *
 * `.shipped_manifest.json` is written on first install only. The server reads it to rebuild the base of a repo that
 * predates bundle tracking.
 */
object AssetExtractor {
    private const val TAG = "AssetExtractor"
    private const val ROOT = "agent"
    private const val MANIFEST = ".shipped_manifest.json"
    /** The staged bundle, and the install it came from. */
    private const val BUNDLE = "agent-bundle"
    private const val STAMP = ".stamp"
    /** The stamp of the bundle the agent's files were last reconciled with. Written by the server. */
    private const val APPLIED = ".applied_stamp"
    /** Generated, never agent-edited: replaced in place on every install and kept out of the staged bundle. */
    private val GENERATED = listOf("vendor", "fallback")

    /** Stages the bundled agent for this install, and returns the directory the agent runs from. */
    fun extractAgentAssets(context: Context): File {
        val liveDir = File(context.filesDir, ROOT)
        val bundleDir = File(context.filesDir, BUNDLE)
        val stamp = installStamp(context)
        if (File(bundleDir, STAMP).takeIf { it.exists() }?.readText()?.trim() == stamp && liveDir.exists()) {
            Log.d(TAG, "Agent bundle already staged for install $stamp")
            return liveDir
        }

        val shipped = listAssets(context, ROOT, "")
        val firstInstall = !File(liveDir, ".git").exists()

        // The server compares this bundle with the agent's files, so the whole shipped tree goes in, minus what is generated.
        bundleDir.deleteRecursively()
        for (path in shipped.filterNot(::isGenerated)) copyAsset(context, path, File(bundleDir, path))
        File(bundleDir, STAMP).writeText(stamp)

        if (firstInstall) {
            // The agent's files are the bundle itself, so the bundle is already applied: no reconcile is needed.
            for (path in shipped) copyAsset(context, path, File(liveDir, path))
            File(liveDir, MANIFEST).writeText(JSONObject(shipped.associateWith { sha256(readAsset(context, it)) }).toString())
            File(liveDir, APPLIED).writeText(stamp)
            Log.d(TAG, "Installed ${shipped.size} agent files into ${liveDir.absolutePath}")
        } else {
            for (generated in GENERATED) {
                File(liveDir, generated).deleteRecursively()
                shipped.filter { it.startsWith("$generated/") }.forEach { copyAsset(context, it, File(liveDir, it)) }
            }
            Log.d(TAG, "Staged agent bundle for install $stamp; the server reconciles it on start")
        }
        return liveDir
    }

    /** True while the staged bundle is not yet recorded as applied: the agent's files must be reconciled first. */
    fun updatePending(context: Context): Boolean {
        val staged = File(context.filesDir, "$BUNDLE/$STAMP").takeIf { it.exists() }?.readText()?.trim() ?: return false
        val applied = File(context.filesDir, "$ROOT/$APPLIED").takeIf { it.exists() }?.readText()?.trim()
        return staged != applied
    }

    private fun isGenerated(path: String): Boolean = GENERATED.any { path.startsWith("$it/") }

    /** Changes on every install or update of the app, which is the only time the shipped assets change. */
    private fun installStamp(context: Context): String {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return "${info.longVersionCode}:${info.lastUpdateTime}"
    }

    private fun copyAsset(context: Context, assetPath: String, target: File) {
        target.parentFile?.mkdirs()
        context.assets.open("$ROOT/$assetPath").use { input -> target.outputStream().use { input.copyTo(it) } }
    }

    private fun readAsset(context: Context, assetPath: String): ByteArray =
        context.assets.open("$ROOT/$assetPath").use { it.readBytes() }

    private fun listAssets(context: Context, assetPath: String, relative: String): List<String> {
        val children = context.assets.list(assetPath).orEmpty()
        if (children.isEmpty()) return if (relative.isEmpty()) emptyList() else listOf(relative)
        return children.flatMap { child ->
            listAssets(context, "$assetPath/$child", if (relative.isEmpty()) child else "$relative/$child")
        }
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
