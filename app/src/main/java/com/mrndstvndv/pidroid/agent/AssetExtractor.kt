package com.mrndstvndv.pidroid.agent

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

object AssetExtractor {
    private const val TAG = "AssetExtractor"

    fun extractAgentAssets(context: Context, force: Boolean = false): File {
        val targetDir = File(context.filesDir, "agent")
        val versionFile = File(targetDir, ".installed_version")
        val currentVersion = "1.0.1"

        if (!force && targetDir.exists() && versionFile.exists() && versionFile.readText() == currentVersion) {
            Log.d(TAG, "Agent assets already up-to-date at ${targetDir.absolutePath}")
            return targetDir
        }

        Log.d(TAG, "Extracting agent assets to ${targetDir.absolutePath}...")
        targetDir.mkdirs()
        copyAssetFolder(context, "agent", targetDir)
        versionFile.writeText(currentVersion)
        return targetDir
    }

    private fun copyAssetFolder(context: Context, assetPath: String, targetDir: File) {
        val assetManager = context.assets
        val files = assetManager.list(assetPath) ?: return

        if (files.isEmpty()) {
            // It's a file
            val targetFile = targetDir
            copyAssetFile(context, assetPath, targetFile)
        } else {
            // It's a directory
            targetDir.mkdirs()
            for (file in files) {
                val subAssetPath = if (assetPath.isEmpty()) file else "$assetPath/$file"
                val subTargetFile = File(targetDir, file)
                val subFiles = assetManager.list(subAssetPath)
                if (subFiles != null && subFiles.isNotEmpty()) {
                    copyAssetFolder(context, subAssetPath, subTargetFile)
                } else {
                    copyAssetFile(context, subAssetPath, subTargetFile)
                }
            }
        }
    }

    private fun copyAssetFile(context: Context, assetPath: String, targetFile: File) {
        targetFile.parentFile?.mkdirs()
        context.assets.open(assetPath).use { input ->
            FileOutputStream(targetFile).use { output ->
                input.copyTo(output)
            }
        }
    }
}
