/**
 * 文件职责：承载 Android 更新检查、受控下载及系统安装器交接。
 * 定义范围：稳定版候选、版本规则和原生更新会话。
 */
package app.taskrail.mobilebridge

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
import java.io.FileOutputStream
import java.io.IOException
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

/** 单次网络操作的重试次数；每次重试都新建连接，只用于吸收连接被中断的抖动。 */
private const val requestAttempts = 3
/** 重试前的线性退避基数；过短会让同一故障连续失败，过长会拖慢用户主动重试。 */
private const val retryDelayMillis = 600L
/** 解析 206 响应 `Content-Range` 起始偏移的匹配式。 */
private val contentRangePattern = Regex("""bytes (\d+)-""")

/**
 * 结构职责：描述来自固定 GitHub 仓库的稳定版 Android 安装包。
 * 字段说明：version 是发布版本，url 是 HTTPS 资产地址，size 是发布资产大小。
 * 约束条件：候选不可由前端提供；安装前仍须检查包名、版本和安装签名。
 */
internal data class AndroidUpdateCandidate(val version: String, val body: String, val url: String, val size: Long)

/**
 * 结构职责：保存一次安装包下载的断点续传状态。
 * 字段说明：received 是当前文件已确认写入的字节数；etag 是服务端最近一次给出的资源标识。
 * 约束条件：只在单次下载会话内有效；服务端忽略范围请求或资源变化时必须丢弃已写入内容。
 */
private class DownloadSession(val file: File) {
    var received = 0L
    var etag: String? = null
}

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
                if (!url.startsWith("https://github.com/Mowonhua/taskrail/releases/download/") || asset.optLong("size") <= 0) continue
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
            val json = request("https://api.github.com/repos/Mowonhua/taskrail/releases?per_page=30", token) { response, status ->
                check(status == 200) { "更新服务器返回 HTTP $status" }
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
                val size = downloadTo(file, release, token, invoke)
                validate(file, release)
                finish(token, invoke, { file.delete() }) {
                    downloaded?.takeUnless { it in handedOff }?.delete()
                    downloaded = file
                    // 完成事件直接发送：finish 已清空 pending，经过 publishProgress 会被当作迟到回调丢弃。
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
     * 函数职责：把安装包下载到目标文件，连接中断后从已写入字节继续。
     * 输入说明：file 必须是本次会话独占的临时文件；release.size 是发布资产大小。
     * 输出说明：返回完整文件的字节数；服务端忽略范围请求时从头重下。
     * 实现思路：每轮携带 Range 和 If-Range，只接受与已写入位置一致的 206；200 表示资源不匹配，截断重写。
     */
    private fun downloadTo(file: File, release: AndroidUpdateCandidate, token: Long, invoke: Invoke): Long {
        val session = DownloadSession(file)
        return request(
            release.url,
            token,
            prepare = { connection ->
                session.received = file.length()
                val etag = session.etag
                if (session.received > 0 && etag != null) {
                    connection.setRequestProperty("Range", "bytes=${session.received}-")
                    connection.setRequestProperty("If-Range", etag)
                }
            },
        ) { response, status ->
            val resumed = status == 206
            check(status == 200 || resumed) { "更新服务器返回 HTTP $status" }
            if (resumed) {
                check(contentRangeOffset(response) == session.received) { "更新续传位置不匹配" }
            } else {
                // 服务端忽略 Range 或资源已变化：丢弃旧字节，从零重写。
                session.received = 0L
            }
            response.getHeaderField("ETag")?.takeIf { it.isNotBlank() }?.let { session.etag = it }
            var lastProgress = 0L
            response.inputStream.use { input ->
                FileOutputStream(file, resumed).use { output ->
                    val bytes = ByteArray(64 * 1024)
                    while (true) {
                        val count = input.read(bytes)
                        if (count < 0) break
                        ensureCurrent(token)
                        check(session.received + count <= release.size) { "安装包大小不匹配" }
                        output.write(bytes, 0, count)
                        session.received += count
                        val now = System.currentTimeMillis()
                        if (now - lastProgress >= 200) {
                            lastProgress = now
                            publishProgress(token, invoke, session.received, release.size)
                        }
                    }
                }
            }
            check(session.received == release.size) { "安装包下载不完整" }
            session.received
        }
    }
    /** 解析 206 响应 `Content-Range` 的起始偏移；缺失或格式非法时返回 -1，触发续传位置校验失败。 */
    private fun contentRangeOffset(response: HttpsURLConnection): Long {
        val header = response.getHeaderField("Content-Range") ?: return -1L
        return contentRangePattern.find(header)?.groupValues?.getOrNull(1)?.toLongOrNull() ?: -1L
    }
    /** 进度只覆盖当前会话；取消后迟到的回调不能写入新一轮下载。 */
    private fun publishProgress(token: Long, invoke: Invoke, received: Long, total: Long) {
        activity.runOnUiThread {
            synchronized(this) {
                if (generation == token && pending === invoke) progress(progressResult(received, total))
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

    /**
     * 函数职责：执行受控 HTTPS 请求，跟随重定向并在传输层失败时重试。
     * 输入说明：prepare 在每次连接建立前设置请求头；read 处理最终响应并完整读取或写入内容。
     * 输出说明：返回 read 的结果；重试耗尽后抛出最后一次网络异常。
     * 实现思路：每轮都新建连接；只对 IOException 重试，HTTP 状态和协议错误立即失败，取消时停止重试。
     */
    private fun <T> request(
        address: String,
        token: Long,
        prepare: (HttpsURLConnection) -> Unit = {},
        read: (HttpsURLConnection, Int) -> T,
    ): T {
        var failure: Exception? = null
        for (round in 0 until requestAttempts) {
            ensureCurrent(token)
            try {
                return attemptOnce(address, token, prepare, read)
            } catch (error: IOException) {
                failure = error
                // close() 后旧请求立即失效，不再消耗退避等待。
                ensureCurrent(token)
                if (round < requestAttempts - 1) Thread.sleep(retryDelayMillis * (round + 1))
            }
        }
        throw failure ?: IOException("更新请求失败")
    }
    /** 手动跟随 HTTPS 重定向，防止资产地址跳转到明文连接；每跳均可由 close 中断。 */
    private fun <T> attemptOnce(
        address: String,
        token: Long,
        prepare: (HttpsURLConnection) -> Unit,
        read: (HttpsURLConnection, Int) -> T,
    ): T {
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
                response.setRequestProperty("User-Agent", "Taskrail-Android")
                response.setRequestProperty("Accept", if (url.host == "api.github.com") "application/vnd.github+json" else "application/octet-stream")
                prepare(response)
                val status = response.responseCode
                if (status in listOf(301, 302, 303, 307, 308)) {
                    url = URL(url, response.getHeaderField("Location") ?: error("更新重定向无效"))
                } else {
                    return read(response, status)
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
