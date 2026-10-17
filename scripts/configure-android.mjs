/** 为 Tauri 生成的 Android 工程补充签名与生命周期配置；可重复运行。 */
import { readFile, writeFile } from 'node:fs/promises';
const gradlePath = 'src-tauri/gen/android/app/build.gradle.kts';
let gradle = await readFile(gradlePath, 'utf8');
if (!gradle.includes('// FOLDMARK_SIGNING')) {
  const signing = `    // FOLDMARK_SIGNING：密钥与密码只从仓库外的文件读取。
    val foldmarkKeystore = System.getenv("FOLDMARK_ANDROID_KEYSTORE")
    if (!foldmarkKeystore.isNullOrBlank()) {
        signingConfigs.create("foldmarkRelease") {
            storeFile = file(foldmarkKeystore)
            keyAlias = System.getenv("FOLDMARK_ANDROID_KEY_ALIAS") ?: "foldmark"
            val passwordFile = requireNotNull(System.getenv("FOLDMARK_ANDROID_PASSWORD_FILE")) { "Missing Android signing password file" }
            val password = file(passwordFile).readText().trim()
            storePassword = password
            keyPassword = password
        }
    }
`;
  if (!gradle.includes('    buildTypes {') || !gradle.includes('getByName("release") {')) throw new Error('Android Gradle 模板结构已变化，请检查签名位置');
  gradle = gradle.replace('    buildTypes {', signing + '\n    buildTypes {');
  gradle = gradle.replace('getByName("release") {', 'getByName("release") {\n            if (!foldmarkKeystore.isNullOrBlank()) signingConfig = signingConfigs.getByName("foldmarkRelease")');
  await writeFile(gradlePath, gradle);
}
if (!gradle.includes('// FOLDMARK_DEBUG_SIGNING')) {
  gradle = gradle.replace('getByName("debug") {', 'getByName("debug") {\n            // FOLDMARK_DEBUG_SIGNING：验收包与正式包使用同一签名，可保留数据升级。\n            if (!foldmarkKeystore.isNullOrBlank()) signingConfig = signingConfigs.getByName("foldmarkRelease")');
  await writeFile(gradlePath, gradle);
}
const manifestPath = 'src-tauri/gen/android/app/src/main/AndroidManifest.xml';
let manifest = await readFile(manifestPath, 'utf8');
// 设备凭证不能随系统备份复制到另一台手机。
manifest = manifest.replace(/android:allowBackup="[^"]*"/, 'android:allowBackup="false"');
if (!manifest.includes('android:allowBackup=')) manifest = manifest.replace('<application', '<application android:allowBackup="false"');
if (!manifest.includes('android:windowSoftInputMode=')) manifest = manifest.replace('<activity', '<activity android:windowSoftInputMode="adjustResize"');
await writeFile(manifestPath, manifest);
const propertiesPath = 'src-tauri/gen/android/gradle.properties';
let properties = await readFile(propertiesPath, 'utf8');
if (!properties.includes('kotlin.incremental=false')) {
  properties += '\n# Cargo 缓存与项目可位于不同 Windows 盘符，禁用跨根目录的 Kotlin 增量缓存。\nkotlin.incremental=false\n';
  await writeFile(propertiesPath, properties);
}
console.log('Android 签名与窗口配置已就绪。');
