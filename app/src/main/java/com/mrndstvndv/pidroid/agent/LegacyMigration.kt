package com.mrndstvndv.pidroid.agent

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import com.mrndstvndv.pidroid.bridge.Capabilities
import org.json.JSONException
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * One-time move from the layout before bundles (the editable $HOME/agent tree and its $HOME/agent-bundle staging) to the
 * current one ($HOME/data for state, bundles/ for code).
 *
 *  1. state moves into data/: the SQLite databases, credentials, the model store, machines/, uploads/ and exports/.
 *     A name already in data/ is kept; directories are merged.
 *  2. the .ts files in agent/extensions/ that the shipped set never had (the agent's own extensions) are copied to data/extensions/.
 *  3. the agent's edits (files that differ from .shipped_manifest.json, or are absent from it) are zipped and saved to
 *     Downloads through MediaStore (API 29+) or a public file on older APIs; when that fails the zip stays in
 *     data/legacy-<ts>.zip. The user is notified where it is.
 *  4. agent/ and agent-bundle/ are deleted, and data/.migrated-v1 is written last.
 *
 * Each step is safe to run again after a crash: moves skip what is already in place, and the marker is the only thing
 * that ends the migration. Errors propagate, so the start fails and the next start retries.
 */
object LegacyMigration {
    private const val TAG = "LegacyMigration"
    private const val MARKER = ".migrated-v1"
    private const val LEGACY_TREE = "agent"
    private const val LEGACY_STAGING = "agent-bundle"
    private const val SHIPPED_MANIFEST = ".shipped_manifest.json"

    /** Files moved as they are from the old tree into data/. SQLite files also come with -wal, -shm and -journal. */
    private val MOVED_FILES = listOf("auth.json", "auth.json.tmp", "pidroid-models.json", "pidroid-models.json.tmp")
    private val MOVED_DIRS = listOf("machines", "uploads", "exports")
    private val SQLITE_BASES = listOf("pidroid.sqlite", "pidroid-agent.sqlite")

    /** Top-level entries of the old tree that are neither state nor the agent's edits: git, generated trees and stamps. */
    private val NOT_EDITS = setOf(
        ".tmp", "vendor", "fallback", "node_modules", ".installed_version", ".stamp", ".applied_stamp",
        "bundle.json", SHIPPED_MANIFEST,
    )

    /** Runs the migration unless its marker exists. Safe to call before every start. */
    fun migrateIfNeeded(context: Context) {
        val data = File(context.filesDir, "data").apply { mkdirs() }
        val marker = File(data, MARKER)
        if (marker.exists()) return

        val legacy = File(context.filesDir, LEGACY_TREE)
        if (legacy.isDirectory) {
            moveState(legacy, data)
            copyUnshippedExtensions(legacy, File(data, "extensions"))
            exportEdits(context, legacy, data)?.let { announce(context, it) }
            BundleStore.deleteTree(legacy)
        }
        BundleStore.deleteTree(File(context.filesDir, LEGACY_STAGING))

        val tmp = File(data, "$MARKER.tmp")
        tmp.writeText("1")
        if (!tmp.renameTo(marker)) throw IOException("Could not write ${marker.path}")
        Log.i(TAG, "Migrated the agent layout to ${data.path}")
    }

    private fun isMovedState(name: String): Boolean =
        name in MOVED_FILES || name in MOVED_DIRS || SQLITE_BASES.any { name == it || name.startsWith("$it-") }

    private fun moveState(legacy: File, data: File) {
        for (file in legacy.listFiles().orEmpty()) {
            if (isMovedState(file.name)) moveMerged(file, File(data, file.name))
        }
    }

    /** Renames [src] to [dst]. When [dst] already exists, directories are merged and existing files are kept. */
    private fun moveMerged(src: File, dst: File) {
        if (!dst.exists()) {
            if (!src.renameTo(dst)) throw IOException("Could not move ${src.path} to ${dst.path}")
            return
        }
        if (src.isDirectory && dst.isDirectory) {
            for (child in src.listFiles().orEmpty()) moveMerged(child, File(dst, child.name))
            src.delete()
            return
        }
        // A file both sides have is a copy from an earlier run; the one in data/ is the kept one.
        Log.w(TAG, "Keeping ${dst.path}; ${src.path} is left behind with the old tree")
    }

    private fun copyUnshippedExtensions(legacy: File, extensions: File) {
        // Without a manifest there is no way to tell the agent's own extensions from the shipped ones, so copy none.
        val shipped = shippedHashes(legacy) ?: return
        for (file in File(legacy, "extensions").listFiles().orEmpty()) {
            if (!file.isFile || !file.name.endsWith(".ts") || "extensions/${file.name}" in shipped) continue
            val target = File(extensions, file.name)
            if (target.exists()) continue
            extensions.mkdirs()
            file.copyTo(target)
        }
    }

    /** The shipped file hashes from .shipped_manifest.json, or null when it is missing or unreadable. */
    private fun shippedHashes(legacy: File): Map<String, String>? {
        val manifest = File(legacy, SHIPPED_MANIFEST).takeIf { it.isFile } ?: return null
        val json = try {
            JSONObject(manifest.readText())
        } catch (e: JSONException) {
            Log.w(TAG, "$SHIPPED_MANIFEST is unreadable", e)
            return null
        }
        return json.keys().asSequence().associateWith { json.getString(it) }
    }

    /** Files of the old tree that differ from what shipped, or that the shipped set never had. Keyed by their path in the tree. */
    private fun collectEdits(legacy: File): List<Pair<String, File>> {
        val shipped = shippedHashes(legacy) ?: emptyMap()
        val edits = mutableListOf<Pair<String, File>>()
        fun visit(dir: File, prefix: String) {
            for (file in dir.listFiles().orEmpty().sortedBy { it.name }) {
                if (file.name == ".git") continue
                val relative = if (prefix.isEmpty()) file.name else "$prefix/${file.name}"
                if (prefix.isEmpty() && (file.name in NOT_EDITS || isMovedState(file.name))) continue
                if (file.isDirectory) {
                    visit(file, relative)
                } else if (shipped[relative] != BundleVerifier.sha256(file)) {
                    edits += relative to file
                }
            }
        }
        visit(legacy, "")
        return edits
    }

    /**
     * Zips the agent's edits and saves the zip to Downloads, or keeps it in data/ when Downloads is not writable.
     * Returns where the zip is, or null when there were no edits.
     */
    private fun exportEdits(context: Context, legacy: File, data: File): String? {
        val edits = collectEdits(legacy)
        if (edits.isEmpty()) return null
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val name = "pidroid-legacy-$stamp.zip"
        val local = File(data, "legacy-$stamp.zip")
        writeZip(local, edits)
        return try {
            publishToDownloads(context, local, name)
            local.delete()
            "Downloads/$name"
        } catch (e: Exception) {
            Log.w(TAG, "Could not save the agent edits to Downloads; keeping ${local.path}", e)
            local.path
        }
    }

    private fun writeZip(target: File, edits: List<Pair<String, File>>) {
        ZipOutputStream(BufferedOutputStream(FileOutputStream(target))).use { zip ->
            for ((path, file) in edits) {
                zip.putNextEntry(ZipEntry(path))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }

    /** Copies [zip] into the public Downloads directory under [name]. Throws when it cannot be written. */
    @Suppress("DEPRECATION") // Pre-Q path: the public directory is the only way to reach Downloads there.
    private fun publishToDownloads(context: Context, zip: File, name: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "application/zip")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IOException("MediaStore refused $name")
            try {
                val out = resolver.openOutputStream(uri) ?: throw IOException("No output stream for $name")
                out.use { stream -> zip.inputStream().use { it.copyTo(stream) } }
                resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            } catch (e: Exception) {
                resolver.delete(uri, null, null)
                throw e
            }
        } else {
            zip.copyTo(File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), name))
        }
    }

    private fun announce(context: Context, location: String) {
        runCatching {
            Capabilities.showNotification(
                context,
                "Agent edits saved",
                "Your changes to the old agent code are in $location.",
            )
        }.onFailure { Log.w(TAG, "Could not post the migration notification", it) }
    }
}
