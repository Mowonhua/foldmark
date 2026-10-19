import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 37
    namespace = "app.taskrail.mobile"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.taskrail.mobile"
        minSdk = 26
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    // TASKRAIL_SIGNING：密钥与密码只从仓库外的文件读取。
    val taskrailKeystore = System.getenv("TASKRAIL_ANDROID_KEYSTORE")
    if (!taskrailKeystore.isNullOrBlank()) {
        signingConfigs.create("taskrailRelease") {
            storeFile = file(taskrailKeystore)
            keyAlias = System.getenv("TASKRAIL_ANDROID_KEY_ALIAS") ?: "taskrail"
            val passwordFile = requireNotNull(System.getenv("TASKRAIL_ANDROID_PASSWORD_FILE")) { "Missing Android signing password file" }
            val password = file(passwordFile).readText().trim()
            storePassword = password
            keyPassword = password
        }
    }

    buildTypes {
        getByName("debug") {
            // TASKRAIL_DEBUG_SIGNING：验收包与正式包使用同一签名，可保留数据升级。
            if (!taskrailKeystore.isNullOrBlank()) signingConfig = signingConfigs.getByName("taskrailRelease")
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (!taskrailKeystore.isNullOrBlank()) signingConfig = signingConfigs.getByName("taskrailRelease")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
