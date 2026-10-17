/**
 * 文件职责：承载 Android 更新检查、受控下载及系统安装器交接。
 * 定义范围：稳定版候选、版本规则和原生更新会话。
 */
package app.foldmark.mobilebridge

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import org.json.JSONArray
import java.io.File
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

/**
 * 结构职责：描述来自固定 GitHub 仓库的稳定版 Android 安装包。
 * 字段说明：version 是发布版本，url 是 HTTPS 资产地址，size 是发布资产大小。
 * 约束条件：候选不可由前端提供；安装前仍须检查包名、版本和安装签名。
 */
internal data class AndroidUpdateCandidate(val version: String, val body: String, val url: String, val size: Long)

/**
 * 接口职责：隔离版本比较及发布元数据选择规则。
 * 调用方：原生更新会话和不依赖 Android 运行环境的单元测试。
 * 实现要求：只接受较新的正式版本和 arm64 APK，拒绝预发布版本。
 */
internal object AndroidUpdateRules {
    private fun version(value: String): List<Long>? {
        val match = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)$").matchEntire(value) ?: return null
        return match.groupValues.drop(1).map { it.toLongOrNull() ?: return null }
    }

    fun isNewer(candidate: String, current: String): Boolean {
        val next = version(candidate) ?: return false
        val installed = version(current) ?: return false
        for (index in next.indices) {
            if (next[index] != installed[index]) return next[index] > installed[index]
        }
        return false
    }

    fun selectRelease(releases: String, current: String): AndroidUpdateCandidate? {
        val entries = JSONArray(releases)
        var selected: AndroidUpdateCandidate? = null
        for (index in 0 until entries.length()) {
            val release = entries.getJSONObject(index)
            val version = release.optString("tag_name").removePrefix("v")
            if (release.optBoolean("draft") || release.optBoolean("prerelease") || !isNewer(version, current)) continue
            if (selected != null && !isNewer(version, selected.version)) continue
            val assets = release.optJSONArray("assets") ?: continue
            for (assetIndex in 0 until assets.length()) {
                val asset = assets.getJSONObject(assetIndex)
                val name = asset.optString("name").lowercase()
                val url = asset.optString("browser_download_url")
                if (!name.endsWith(".apk") || !(name.contains("arm64") || name.contains("aarch64"))) continue
                if (!url.startsWith("https://github.com/Mowonhua/foldmark/releases/download/") || asset.optLong("size") <= 0) continue
                selected = AndroidUpdateCandidate(version, release.optString("body"), url, asset.getLong("size"))
                break
            }
        }
        return selected
    }
}

/**
 * 接口职责：管理单个应用的更新会话和系统安装交接。
 * 调用方：MobilePlugin 暴露的四个更新命令。
 * 实现要求：网络在工作线程执行；并发请求拒绝；关闭会使旧请求失效并清理文件。
 */
internal class AndroidUpdater(private val activity: Activity, private val progress: (JSObject) -> Unit) {
    private val worker = Executors.newSingleThreadExecutor()
    private val cache = File(activity.cacheDir, "updates").apply {
        mkdirs()
        // 重启之后无法确认系统安装器是否仍持有 URI，只清理超过一天的旧文件。
        listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24 * 60 * 60 * 1000L }?.forEach { it.delete() }
    }
    private var generation = 0L
    private var pending: Invoke? = null
    private var candidate: AndroidUpdateCandidate? = null
    private var downloaded: File? = null
    // 安装器异步读取 URI。已交接文件在当前进程内保留，避免关闭或重查时使系统读取失败。
    private val handedOff = mutableSetOf<File>()
    @Volatile private var connection: HttpsURLConnection? = null

    /**
     * 函数职责：检查固定仓库的较新正式 Android 发布。
     * 输入说明：命令不接受外部下载地址。
     * 输出说明：返回 available、currentVersion 以及可用时的 version、body。
     * 实现思路：读取已安装版本和 GitHub 发布元数据，保存经过筛选的候选。
     */
    fun check(invoke: Invoke) {
        run(invoke) { token ->
            val current = installed().versionName ?: error("无法读取当前版本")
            val json = request("https://api.github.com/repos/Mowonhua/foldmark/releases?per_page=30", token) { response ->
                response.inputStream.bufferedReader().use { reader ->
                    val body = StringBuilder()
                    val characters = CharArray(8192)
                    while (true) {
                        val count = reader.read(characters)
                        if (count < 0) break
                        ensureCurrent(token)
                        check(body.length + count <= 4_000_000) { "更新响应过大" }
                        body.append(characters, 0, count)
                    }
                    body.toString()
                }
            }
            val release = AndroidUpdateRules.selectRelease(json, current)
            finish(token, invoke) {
                downloaded?.takeUnless { it in handedOff }?.delete()
                downloaded = null
                candidate = release
                invoke.resolve(JSObject().apply {
                    put("available", release != null); put("currentVersion", current)
                    release?.let { put("version", it.version); put("body", it.body) }
                })
            }
        }
    }
    /**
     * 函数职责：下载当前候选并校验可安装身份。
     * 输入说明：必须已经成功检查并得到候选。
     * 输出说明：进度和完成结果包含 downloadedBytes、totalBytes。
     * 实现思路：仅将 HTTPS 内容写入私有缓存，完成后检查包名、递增版本及签名。
     */
    fun download(invoke: Invoke) {
        val release = synchronized(this) { candidate }
        if (release == null) { invoke.reject("请先检查更新"); return }
        run(invoke) { token ->
            val file = File.createTempFile("update-", ".apk", cache)
            try {
                val size = request(release.url, token) { response ->
                    var received = 0L
                    var lastProgress = 0L
                    response.inputStream.use { input ->
                        file.outputStream().use { output ->
                            val bytes = ByteArray(64 * 1024)
                            while (true) {
                                val count = input.read(bytes)
                                if (count < 0) break
                                ensureCurrent(token)
                                received += count
                                check(received <= release.size) { "安装包大小不匹配" }
                                output.write(bytes, 0, count)
                                val now = System.currentTimeMillis()
                                if (now - lastProgress >= 200) {
                                    lastProgress = now
                                    activity.runOnUiThread {
                                        synchronized(this) {
                                            if (generation == token && pending === invoke) progress(progressResult(received, release.size))
                                        }
                                    }
                                }
                            }
                        }
                    }
                    check(received == release.size) { "安装包下载不完整" }
                    received
                }
                validate(file, release)
                finish(token, invoke, { file.delete() }) {
                    downloaded?.takeUnless { it in handedOff }?.delete()
                    downloaded = file
                    progress(progressResult(size, release.size))
                    invoke.resolve(progressResult(size, release.size))
                }
            } catch (error: Exception) {
                file.delete()
                throw error
            }
        }
    }
    /**
     * 函数职责：请求未知来源授权或打开系统安装器。
     * 输入说明：只能安装当前会话已验证的文件。
     * 输出说明：返回 permission-required 或 installer-opened，安装结果由系统管理。
     * 实现思路：授权不足时打开设置；授权齐备时通过只读 FileProvider URI 交接文件。
     */
    @Synchronized fun install(invoke: Invoke) {
        if (pending != null) { invoke.reject("更新操作正在进行"); return }
        val file = downloaded
        val release = candidate
        if (file == null || release == null) { invoke.reject("请先下载更新"); return }
        try {
            validate(file, release)
            if (!activity.packageManager.canRequestPackageInstalls()) {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                invoke.resolve(JSObject().apply { put("status", "permission-required") })
                return
            }
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", file)
            activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
            handedOff.add(file)
            invoke.resolve(JSObject().apply { put("status", "installer-opened") })
        } catch (error: Exception) { invoke.reject(error.message ?: "无法打开安装器") }
    }
    /**
     * 函数职责：取消未完成请求并释放候选和缓存。
     * 输入说明：可重复调用，不影响已经打开的系统安装器读取文件。
     * 输出说明：旧回调不得覆盖后续会话。
     * 实现思路：使会话标记失效、断开连接，关闭未交给系统的安装文件。
     */
    @Synchronized fun close() {
        generation += 1
        connection?.disconnect()
        connection = null
        pending?.reject("更新操作已取消")
        pending = null
        candidate = null
        downloaded?.takeUnless { it in handedOff }?.delete()
        downloaded = null
    }

    fun destroy() { close(); worker.shutdownNow() }

    /** 所有命令共享会话序号。取消立即结算旧调用，工作线程只清理文件，不再写入新会话。 */
    @Synchronized private fun run(invoke: Invoke, action: (Long) -> Unit) {
        if (pending != null) { invoke.reject("更新操作正在进行"); return }
        generation += 1
        val token = generation
        pending = invoke
        worker.execute {
            try { action(token) }
            catch (error: Exception) {
                finish(token, invoke) { invoke.reject(error.message ?: "更新失败") }
            }
        }
    }

    private fun finish(token: Long, invoke: Invoke, stale: () -> Unit = {}, action: () -> Unit) {
        activity.runOnUiThread {
            synchronized(this) {
                if (generation != token || pending !== invoke) { stale(); return@runOnUiThread }
                pending = null
                try { action() }
                catch (error: Exception) { invoke.reject(error.message ?: "更新失败") }
            }
        }
    }

    @Synchronized private fun ensureCurrent(token: Long) {
        check(generation == token && pending != null) { "更新操作已取消" }
    }

    /** 手动跟随 HTTPS 重定向，防止资产地址跳转到明文连接；每跳均可由 close 中断。 */
    private fun <T> request(address: String, token: Long, read: (HttpsURLConnection) -> T): T {
        var url = URL(address)
        repeat(6) {
            ensureCurrent(token)
            check(url.protocol == "https") { "更新仅允许 HTTPS" }
            val response = url.openConnection() as HttpsURLConnection
            synchronized(this) { ensureCurrent(token); connection = response }
            try {
                response.connectTimeout = 20_000
                response.readTimeout = 30_000
                response.instanceFollowRedirects = false
                response.setRequestProperty("User-Agent", "Foldmark-Android")
                response.setRequestProperty("Accept", if (url.host == "api.github.com") "application/vnd.github+json" else "application/octet-stream")
                val status = response.responseCode
                if (status in listOf(301, 302, 303, 307, 308)) {
                    url = URL(url, response.getHeaderField("Location") ?: error("更新重定向无效"))
                } else {
                    check(status == 200) { "更新服务器返回 HTTP $status" }
                    return read(response)
                }
            } finally {
                response.disconnect()
                synchronized(this) { if (connection === response) connection = null }
            }
        }
        error("更新重定向过多")
    }

    private fun progressResult(received: Long, total: Long) = JSObject().apply {
        put("downloadedBytes", received); put("totalBytes", total)
    }

    @Suppress("DEPRECATION")
    private fun installed(): PackageInfo = activity.packageManager.getPackageInfo(activity.packageName, signatureFlags())

    @Suppress("DEPRECATION")
    private fun signatureFlags(): Int = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

    /** 使用安装包当前签名集合的严格相等校验；不接受其他签名，即使包名和版本相同。 */
    @Suppress("DEPRECATION")
    private fun signatures(info: PackageInfo): Set<String> {
        val values = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        return values?.map { it.toCharsString() }?.toSet().orEmpty()
    }

    @Suppress("DEPRECATION")
    private fun validate(file: File, release: AndroidUpdateCandidate) {
        check(file.isFile && file.length() == release.size) { "安装包文件无效" }
        val archive = activity.packageManager.getPackageArchiveInfo(file.absolutePath, signatureFlags()) ?: error("无法读取安装包")
        val current = installed()
        check(archive.packageName == activity.packageName) { "安装包应用标识不匹配" }
        check(archive.versionName == release.version && AndroidUpdateRules.isNewer(release.version, current.versionName ?: "")) { "安装包版本不匹配" }
        val nextCode = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        val currentCode = if (Build.VERSION.SDK_INT >= 28) current.longVersionCode else current.versionCode.toLong()
        check(nextCode > currentCode) { "安装包版本号未递增" }
        val trusted = signatures(current)
        check(trusted.isNotEmpty() && signatures(archive) == trusted) { "安装包签名不匹配" }
    }
}

/** 独立 provider 类型让 Android 稳定创建更新文件提供器，只暴露 updates 缓存子目录。 */
class UpdateFileProvider : FileProvider()
