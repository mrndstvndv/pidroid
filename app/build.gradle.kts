import java.io.File
import java.security.MessageDigest
import java.util.Properties
import javax.inject.Inject
import org.gradle.process.ExecOperations

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
}

val appVersionCode = (findProperty("versionCode") as String?)?.toInt() ?: 1
/** Host API level this APK implements; a bundle with a higher minHostApi needs a newer APK. */
val hostApi = (findProperty("hostApi") as String?)?.toInt() ?: 1
/** Version of the bundle's on-device data layout; state is never rolled back below the highest one activated. */
val bundleSchemaVersion = (findProperty("bundleSchemaVersion") as String?)?.toInt() ?: 1
/** Base64 X.509 DER public key that verifies bundle signatures; empty when not configured. */
val bundlePublicKey = (findProperty("bundlePublicKey") as String?).orEmpty()

/**
 * Helpers for BundleAgentTask. They live in an object rather than at the top level of this script: a task class that
 * called script members would hold the script instance, which the configuration cache cannot store.
 */
object AgentAssets {
  /**
   * AGP's default asset ignore pattern (AaptOptions.ignoreAssetsPattern). aapt applies it to every file and directory
   * name: the first matching entry decides, and a `!` entry keeps a name. `.*` drops hidden entries, so the agent's
   * .gitignore and .icons/ never reach the APK; `<dir>_*` drops directories starting with an underscore.
   */
  class AssetIgnoreRule(val keep: Boolean, val dirsOnly: Boolean, val name: Regex)

  fun globRegex(glob: String): Regex = Regex(
    glob.map { c -> if (c == '*') ".*" else if (c == '?') "." else Regex.escape(c.toString()) }.joinToString(""),
    RegexOption.IGNORE_CASE,
  )

  val assetIgnoreRules: List<AssetIgnoreRule> = listOf(
    "!.svn", "!.git", "!.ds_store", "!*.scc", ".*", "<dir>_*", "!CVS", "!thumbs.db", "!picasa.ini", "!*~",
  ).map { raw ->
    val body = raw.removePrefix("!")
    AssetIgnoreRule(
      keep = raw.startsWith("!"),
      dirsOnly = body.startsWith("<dir>"),
      name = globRegex(body.removePrefix("<dir>")),
    )
  }

  fun isIgnoredAsset(name: String, isDir: Boolean): Boolean {
    for (rule in assetIgnoreRules) {
      if (rule.dirsOnly && !isDir) continue
      if (rule.name.matches(name)) return !rule.keep
    }
    return false
  }

  /** The files AGP packages from [dir] as assets, keyed by their slash-separated path relative to [dir]. */
  fun collectAssets(dir: File, into: MutableMap<String, File>, prefix: String = ""): MutableMap<String, File> {
    for (file in dir.listFiles().orEmpty().sortedBy { it.name }) {
      if (isIgnoredAsset(file.name, file.isDirectory)) continue
      val rel = if (prefix.isEmpty()) file.name else "$prefix/${file.name}"
      if (file.isDirectory) collectAssets(file, into, rel) else into[rel] = file
    }
    return into
  }

  fun sha256(file: File): String =
    MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it.toInt() and 0xff) }

  fun jsonString(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}

/**
 * Builds the agent bundle: what the phone runs from source with no node_modules, embedded in the APK under assets/agent
 * and packaged as the OTA/manual-import zip (see packageAgentBundle).
 *  - vendor/ + tsconfig.json: the npm dependencies as split bundles, with `paths` mapping package names to them, so
 *    server.ts and the agent's own extensions run (and can be edited) as plain TypeScript;
 *  - bundle.json: the bundle's identity (version, code, channel, host API, schema) and the sha256 of every file in it.
 * Dependencies install from the committed bun.lock (--frozen-lockfile) in a scratch dir, keeping node_modules out of the APK.
 */
abstract class BundleAgentTask @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
  @get:InputDirectory
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val agentDir: DirectoryProperty

  /** package.json, bun.lock and build-vendor.ts */
  @get:InputDirectory
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val toolsDir: DirectoryProperty

  @get:Internal
  abstract val workDir: DirectoryProperty

  /** Asset root for the APK; the bundle itself is in its agent/ subdirectory. */
  @get:OutputDirectory
  abstract val outputDir: DirectoryProperty

  /** The bundle as the release zip is made from it: the packaged source files with the generated ones on top. */
  @get:OutputDirectory
  abstract val stageDir: DirectoryProperty

  @get:Input
  abstract val bundleVersion: Property<String>

  @get:Input
  abstract val bundleCode: Property<Int>

  /** "local", "stable" or "prerelease" */
  @get:Input
  abstract val bundleChannel: Property<String>

  @get:Input
  abstract val minHostApi: Property<Int>

  @get:Input
  abstract val schemaVersion: Property<Int>

  @get:Input
  abstract val bundleCommit: Property<String>

  @TaskAction
  fun bundle() {
    val work = workDir.get().asFile
    work.deleteRecursively()
    work.mkdirs()
    agentDir.get().asFile.copyRecursively(work, overwrite = true)
    toolsDir.get().asFile.copyRecursively(work, overwrite = true)

    val home = System.getProperty("user.home")
    val path = listOf("$home/.nix-profile/bin", "$home/.bun/bin", System.getenv("PATH") ?: "").joinToString(":")
    val out = outputDir.get().asFile
    out.deleteRecursively()
    val agentOut = out.resolve("agent")
    agentOut.mkdirs()

    fun bun(vararg args: String) = exec.exec {
      workingDir = work
      environment("PATH", path)
      commandLine("bun", *args)
    }
    bun("install", "--frozen-lockfile")
    bun("build-vendor.ts", agentOut.absolutePath)

    // Every file the APK will hold under assets/agent: the packaged source files, with the generated ones on top.
    val files = sortedMapOf<String, File>()
    AgentAssets.collectAssets(agentDir.get().asFile, files)
    AgentAssets.collectAssets(agentOut, files)
    files.remove("bundle.json")

    val hashes = files.mapValues { (_, file) -> AgentAssets.sha256(file) }
    val json = bundleJson(hashes)
    agentOut.resolve("bundle.json").writeText(json)

    val stage = stageDir.get().asFile
    stage.deleteRecursively()
    for ((rel, file) in files) {
      val target = stage.resolve(rel)
      target.parentFile.mkdirs()
      file.copyTo(target, overwrite = true)
    }
    stage.resolve("bundle.json").writeText(json)
  }

  private fun bundleJson(hashes: Map<String, String>): String = buildString {
    appendLine("{")
    appendLine("  \"format\": 1,")
    appendLine("  \"version\": ${AgentAssets.jsonString(bundleVersion.get())},")
    appendLine("  \"code\": ${bundleCode.get()},")
    appendLine("  \"channel\": ${AgentAssets.jsonString(bundleChannel.get())},")
    appendLine("  \"minHostApi\": ${minHostApi.get()},")
    appendLine("  \"schemaVersion\": ${schemaVersion.get()},")
    appendLine("  \"commit\": ${AgentAssets.jsonString(bundleCommit.get())},")
    appendLine("  \"files\": {")
    hashes.entries.forEachIndexed { index, (rel, hash) ->
      val comma = if (index < hashes.size - 1) "," else ""
      appendLine("    ${AgentAssets.jsonString(rel)}: ${AgentAssets.jsonString(hash)}$comma")
    }
    appendLine("  }")
    appendLine("}")
  }
}

val agentBundleStageDir = layout.buildDirectory.dir("generated/agentBundleStage")

val bundleAgent = tasks.register<BundleAgentTask>("bundleAgent") {
  agentDir.set(layout.projectDirectory.dir("src/main/assets/agent"))
  toolsDir.set(layout.projectDirectory.dir("agent-build"))
  workDir.set(layout.buildDirectory.dir("agent-bundle-work"))
  outputDir.set(layout.buildDirectory.dir("generated/agentBundle"))
  stageDir.set(agentBundleStageDir)
  bundleVersion.set(rootProject.version.toString())
  bundleCode.set(appVersionCode)
  // Release builds set these; a local build is "local" at commit "unknown" unless told otherwise.
  bundleChannel.set(providers.gradleProperty("bundleChannel").orElse("local"))
  minHostApi.set(hostApi)
  schemaVersion.set(bundleSchemaVersion)
  bundleCommit.set(
    providers.gradleProperty("bundleCommit").orElse(
      providers.exec {
        commandLine("git", "rev-parse", "HEAD")
        isIgnoreExitValue = true
      }.standardOutput.asText.map { it.trim().takeIf { head -> head.matches(Regex("[0-9a-f]{40}")) } ?: "unknown" },
    ),
  )
}

/**
 * Local dev loop for the agent: `./gradlew packageAgentBundle` writes build/outputs/agent-bundle/pidroid-agent-<version>.zip,
 * the same bundle the APK embeds, with bundle.json at the zip root. It is unsigned, so the app's Updates tab imports it
 * only with "allow unverified".
 */
val packageAgentBundle = tasks.register<Zip>("packageAgentBundle") {
  dependsOn(bundleAgent)
  from(agentBundleStageDir)
  archiveFileName.set("pidroid-agent-${rootProject.version}.zip")
  destinationDirectory.set(layout.buildDirectory.dir("outputs/agent-bundle"))
  isPreserveFileTimestamps = false
  isReproducibleFileOrder = true
}

androidComponents {
  onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(bundleAgent, BundleAgentTask::outputDir)
  }
}

android {
    namespace = "com.mrndstvndv.pidroid"
    compileSdk = 36
    // Pinned so AGP can strip native libs (needs a complete NDK with source.properties).
    ndkVersion = "29.0.14206865"
    defaultConfig {
        applicationId = "com.mrndstvndv.pidroid"
        minSdk = 24
        targetSdk = 36
        versionCode = appVersionCode
        versionName = (findProperty("versionName") as String?) ?: rootProject.version.toString()
        // Only arm64 ships the full native set (Bun + OpenSSH); no x86_64 libs are kept.
        ndk { abiFilters += "arm64-v8a" }
        buildConfigField("int", "HOST_API", "$hostApi")
        buildConfigField("String", "BUNDLE_PUBLIC_KEY", "\"$bundlePublicKey\"")
    }

    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            if (keystorePropertiesFile.exists()) {
                val properties = Properties().apply {
                    keystorePropertiesFile.inputStream().use { load(it) }
                }
                storeFile = properties.getProperty("storeFile")?.let { rootProject.file(it) }
                storePassword = properties.getProperty("storePassword")
                keyAlias = properties.getProperty("keyAlias")
                keyPassword = properties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            if (rootProject.file("keystore.properties").exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
      compose = true
      aidl = false
      buildConfig = true
      shaders = false
    }

    packaging {
      resources {
        excludes += "/META-INF/{AL2.0,LGPL2.1}"
      }
      jniLibs {
        useLegacyPackaging = true
      }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
  val composeBom = platform(libs.androidx.compose.bom)
  implementation(composeBom)
  androidTestImplementation(composeBom)

  // Core Android dependencies
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose)

  // Arch Components
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Compose
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  // Tooling
  debugImplementation(libs.androidx.compose.ui.tooling)
  // Instrumented tests
  androidTestImplementation(libs.androidx.compose.ui.test.junit4)
  debugImplementation(libs.androidx.compose.ui.test.manifest)

  // Local tests: jUnit, coroutines, Android runner
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)

  // Instrumented tests: jUnit rules and runners
  androidTestImplementation(libs.androidx.test.core)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.test.espresso.core)

  // Navigation
  implementation(libs.androidx.navigation3.ui)
  implementation(libs.androidx.navigation3.runtime)
  implementation(libs.androidx.lifecycle.viewmodel.navigation3)
}
