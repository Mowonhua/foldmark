param([switch]$Install, [string]$Device, [switch]$Publish)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
foreach ($taskVariable in @('JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME', 'TASKRAIL_ANDROID_KEYSTORE', 'TASKRAIL_ANDROID_PASSWORD_FILE')) {
    $taskValue = [Environment]::GetEnvironmentVariable($taskVariable)
    if (-not $taskValue -or -not (Test-Path -LiteralPath $taskValue)) { throw "$taskVariable 未设置或路径不存在。" }
}
if (-not (Test-Path -LiteralPath 'src-tauri/gen/android/app/build.gradle.kts')) {
    & node node_modules/@tauri-apps/cli/tauri.js android init --ci --skip-targets-install
    if ($LASTEXITCODE -ne 0) { throw 'Android 工程初始化失败。' }
}
& node scripts/configure-android.mjs
if ($LASTEXITCODE -ne 0) { throw 'Android 配置失败。' }
& node node_modules/@tauri-apps/cli/tauri.js android build --apk --target aarch64 --ci
if ($LASTEXITCODE -ne 0) { throw 'Android 构建失败。' }
$taskApk = Get-ChildItem -LiteralPath 'src-tauri/gen/android/app/build/outputs/apk' -Filter '*release.apk' -Recurse |
    Where-Object Name -NotLike '*unsigned*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $taskApk) { throw '未找到签名 APK。' }
& "$env:ANDROID_HOME\build-tools\37.0.0\apksigner.bat" verify $taskApk.FullName
if ($LASTEXITCODE -ne 0) { throw 'APK 签名验证失败。' }
$taskVersion = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Path 'dist-android' -Force | Out-Null
$taskOutput = Join-Path (Get-Location) "dist-android/Taskrail-$taskVersion-arm64.apk"
Copy-Item -LiteralPath $taskApk.FullName -Destination $taskOutput
Write-Output "签名 APK：$taskOutput"
if ($Publish) {
    # 只向已有版本追加 APK，不替换已经公开的资源；手机从该 Release 检查更新。
    & gh release upload "v$taskVersion" $taskOutput --repo Mowonhua/taskrail
    if ($LASTEXITCODE -ne 0) { throw 'APK 发布失败，请检查对应 Release 是否存在及 GitHub 登录状态。' }
}
if ($Install) {
    if (-not $Device) { throw '安装时必须用 -Device 指定 adb 设备，避免写入错误设备。' }
    & "$env:ANDROID_HOME\platform-tools\adb.exe" -s $Device install -r $taskOutput
    if ($LASTEXITCODE -ne 0) { throw 'APK 安装失败。' }
}
