import java.util.Properties
import javax.inject.Inject
import org.gradle.process.ExecOperations

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
}

/**
 * Builds what the phone needs to run the agent from source with no node_modules:
 *  - vendor/ + tsconfig.json: the npm dependencies as split bundles, with `paths` mapping package names to them, so
 *    server.ts and the agent's own extensions run (and can be edited) as plain TypeScript;
 *  - fallback/server.js: a full bundle of the shipped server, started in safe mode if an edited server keeps failing.
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

  @get:OutputDirectory
  abstract val outputDir: DirectoryProperty

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
    bun("build", "server.ts", "--target=bun", "--outfile=${agentOut.resolve("fallback/server.js").absolutePath}")
  }
}

val bundleAgent = tasks.register<BundleAgentTask>("bundleAgent") {
  agentDir.set(layout.projectDirectory.dir("src/main/assets/agent"))
  toolsDir.set(layout.projectDirectory.dir("agent-build"))
  workDir.set(layout.buildDirectory.dir("agent-bundle-work"))
  outputDir.set(layout.buildDirectory.dir("generated/agentBundle"))
}

androidComponents {
  onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(bundleAgent, BundleAgentTask::outputDir)
  }
}

android {
    namespace = "com.mrndstvndv.pidroid"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.mrndstvndv.pidroid"
        minSdk = 24
        targetSdk = 36
        versionCode = (findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (findProperty("versionName") as String?) ?: rootProject.version.toString()
        // Only arm64 ships the full native set (Bun + OpenSSH); the x86_64 libbun.so is dropped from the APK.
        ndk { abiFilters += "arm64-v8a" }
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
      buildConfig = false
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
