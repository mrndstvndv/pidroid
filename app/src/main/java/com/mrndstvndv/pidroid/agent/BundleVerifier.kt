package com.mrndstvndv.pidroid.agent

import android.content.Context
import android.util.Base64
import com.mrndstvndv.pidroid.BuildConfig
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.zip.ZipInputStream

/** A bundle the host refuses. [code] is "invalid", "incompatible" (needs a newer app) or "unverified" (needs confirmation). */
class BundleException(val code: String, message: String) : Exception(message)

/** bundle.json: the bundle's identity, and the sha256 of every file in it except itself. */
data class BundleManifest(
    val format: Int,
    val version: String,
    val code: Int,
    val channel: String,
    val minHostApi: Int,
    val schemaVersion: Int,
    val commit: String,
    val files: Map<String, String>,
)

/** A zip that passed the checks, extracted into [dir]. [verified] is false only when the caller allowed unsigned bundles. */
class VerifiedBundle(val dir: File, val manifest: BundleManifest, val verified: Boolean)

/**
 * Checks a bundle zip before it can be installed, and extracts it into a staging directory. Nothing is trusted from the
 * zip until its files match the sha256 list in its own bundle.json, and that list is signed with the key the APK holds.
 *  - entries must be plain relative paths: no `..`, no absolute paths, no backslashes, nothing resolving outside staging;
 *  - bundle.json must have format 1 and a minHostApi this APK implements;
 *  - every listed file must exist with its hash, and no other file may be present (bundle.json aside);
 *  - the zip's bytes must verify against the signature (SHA256withECDSA, base64 DER) with BUNDLE_PUBLIC_KEY.
 */
object BundleVerifier {
    private const val MANIFEST = "bundle.json"
    private const val FORMAT = 1

    /**
     * Verifies [zip] and extracts it. [expectedSha256] is the zip's hash from a trusted source (the update manifest), when
     * there is one. An unsigned or unverifiable bundle throws "unverified" unless [allowUnverified] is set. On any failure
     * the staging directory is removed.
     */
    fun verifyZip(
        context: Context,
        zip: File,
        expectedSha256: String?,
        signatureB64: String?,
        allowUnverified: Boolean,
    ): VerifiedBundle {
        if (expectedSha256 != null && !sha256(zip).equals(expectedSha256, ignoreCase = true)) {
            throw BundleException("invalid", "The download does not match its expected checksum")
        }
        val staging = BundleStore.newStagingDir(context)
        try {
            extract(zip, staging)
            val manifest = readManifest(File(staging, MANIFEST))
            if (manifest.format != FORMAT) {
                throw BundleException("incompatible", "Bundle format ${manifest.format} is not supported by this app")
            }
            if (manifest.minHostApi > BuildConfig.HOST_API) {
                throw BundleException(
                    "incompatible",
                    "The bundle needs host API ${manifest.minHostApi}; this app provides ${BuildConfig.HOST_API}",
                )
            }
            checkFiles(staging, manifest)
            val verified = signatureVerified(zip, signatureB64)
            if (!verified && !allowUnverified) {
                throw BundleException("unverified", "The bundle is not signed by a trusted key")
            }
            return VerifiedBundle(staging, manifest, verified)
        } catch (e: BundleException) {
            staging.deleteRecursively()
            throw e
        } catch (e: Exception) {
            staging.deleteRecursively()
            throw BundleException("invalid", e.message ?: "The bundle could not be read")
        }
    }

    /** Parses the bundle.json at [file]. Throws "invalid" if it is missing or malformed. */
    fun readManifest(file: File): BundleManifest {
        if (!file.isFile) throw BundleException("invalid", "The bundle has no bundle.json")
        return parseManifest(file.readText())
    }

    fun parseManifest(text: String): BundleManifest =
        try {
            val json = JSONObject(text)
            val files = json.getJSONObject("files").let { listed ->
                listed.keys().asSequence().associateWith { listed.getString(it) }
            }
            BundleManifest(
                format = json.getInt("format"),
                version = json.getString("version"),
                code = json.getInt("code"),
                channel = json.optString("channel", "local"),
                minHostApi = json.getInt("minHostApi"),
                schemaVersion = json.getInt("schemaVersion"),
                commit = json.optString("commit", "unknown"),
                files = files,
            )
        } catch (e: JSONException) {
            throw BundleException("invalid", "bundle.json is malformed: ${e.message}")
        }

    /** Lowercase hex sha256 of [file]'s bytes. */
    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private fun extract(zip: File, staging: File) {
        val root = staging.canonicalPath + File.separator
        val seen = HashSet<String>()
        ZipInputStream(FileInputStream(zip)).use { input ->
            while (true) {
                val entry = input.nextEntry ?: break
                checkEntryName(entry.name)
                // Directory entries only create the tree below; the files they hold create their own parents.
                if (!entry.isDirectory) {
                    if (!seen.add(entry.name)) throw BundleException("invalid", "${entry.name} is in the zip twice")
                    val target = File(staging, entry.name)
                    if (!target.canonicalPath.startsWith(root)) {
                        throw BundleException("invalid", "${entry.name} would be written outside the bundle")
                    }
                    target.parentFile?.mkdirs()
                    FileOutputStream(target).use { output -> input.copyTo(output) }
                }
                input.closeEntry()
            }
        }
    }

    /** Rejects names that are absolute, use backslashes, or contain empty, `.` or `..` segments. */
    private fun checkEntryName(name: String) {
        if (name.isEmpty() || name.startsWith("/") || name.contains('\\')) {
            throw BundleException("invalid", "Unsafe path in the zip: $name")
        }
        for (part in name.trimEnd('/').split('/')) {
            if (part.isEmpty() || part == "." || part == "..") throw BundleException("invalid", "Unsafe path in the zip: $name")
        }
    }

    private fun checkFiles(staging: File, manifest: BundleManifest) {
        if (MANIFEST in manifest.files) throw BundleException("invalid", "bundle.json cannot list itself")
        for (path in manifest.files.keys) checkEntryName(path)

        val present = staging.walkTopDown()
            .filter { it.isFile }
            .map { it.relativeTo(staging).invariantSeparatorsPath }
            .filter { it != MANIFEST }
            .toSet()
        val unlisted = present - manifest.files.keys
        if (unlisted.isNotEmpty()) throw BundleException("invalid", "${unlisted.first()} is not listed in bundle.json")

        for ((path, hash) in manifest.files) {
            val file = File(staging, path)
            if (!file.isFile) throw BundleException("invalid", "$path is listed in bundle.json but missing")
            if (!sha256(file).equals(hash, ignoreCase = true)) {
                throw BundleException("invalid", "$path does not match its checksum")
            }
        }
    }

    /**
     * True when [signatureB64] signs the zip with the key the APK holds. False when there is no signature or no key to
     * check it against. A signature that is present but does not match is an error, not merely unverified.
     */
    private fun signatureVerified(zip: File, signatureB64: String?): Boolean {
        val publicKey = BuildConfig.BUNDLE_PUBLIC_KEY
        val signature64 = signatureB64?.takeIf { it.isNotBlank() } ?: return false
        if (publicKey.isBlank()) return false
        try {
            val key = KeyFactory.getInstance("EC")
                .generatePublic(X509EncodedKeySpec(Base64.decode(publicKey.filterNot { it.isWhitespace() }, Base64.DEFAULT)))
            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initVerify(key)
            FileInputStream(zip).use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    signature.update(buffer, 0, read)
                }
            }
            val sigBytes = Base64.decode(signature64.filterNot { it.isWhitespace() }, Base64.DEFAULT)
            if (!signature.verify(sigBytes)) throw BundleException("invalid", "The bundle signature does not match")
            return true
        } catch (e: BundleException) {
            throw e
        } catch (e: Exception) {
            throw BundleException("invalid", "The bundle signature could not be checked: ${e.message}")
        }
    }
}
