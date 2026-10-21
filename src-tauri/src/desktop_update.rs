//! 文件职责：承载桌面更新包的版本检查、断点续传下载、签名校验与安装交接。
//! 定义范围：原生更新会话、缓存文件、HTTP 范围请求和平台安装。
//!
//! 版本检查与安装复用 tauri-plugin-updater；下载由其公开的更新候选取得 HTTPS
//! 地址与签名，在本模块内完成可续传的传输和独立校验，避免插件一次性读取整个响应。

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use minisign_verify::{PublicKey, Signature};
use reqwest::{
    header::{ACCEPT, CONTENT_RANGE, ETAG, IF_RANGE, RANGE, USER_AGENT},
    StatusCode,
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 单次网络操作的重试次数；每次重试都新建请求，只用于吸收连接被中断的抖动。
const ATTEMPTS: usize = 3;
/// 重试前的线性退避基数；过短会让同一故障连续失败，过长会拖慢用户主动重试。
const RETRY_BASE_DELAY: Duration = Duration::from_millis(600);
/// 建立连接的上限；下载本身不设总时限，避免大安装包在慢速网络上被整体截断。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 单次读取的最长等待；超时后断开并从已写入字节续传。
const CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const NETWORK_MESSAGE: &str = "网络中断，请检查网络后重试。";

/// 结构职责：向前端发送累计下载字节数。
/// 字段说明：total_bytes 在服务器未提供有效总长度时缺省。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
}

/// 结构职责：描述从更新源取得的候选版本。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    body: Option<String>,
}

/// 结构职责：保存一次检查得到的更新候选及其缓存路径。
/// 约束条件：只在单次应用运行内有效；缓存文件可在重启后按版本和资源标识继续使用。
struct Session {
    generation: u64,
    update: Update,
    partial: PathBuf,
    meta: PathBuf,
    verified: bool,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    session: Option<Session>,
}

/// 结构职责：持有桌面更新会话；所有命令共享同一序号以拒绝迟到的旧操作。
#[derive(Default)]
pub struct DesktopUpdateState {
    inner: Mutex<Inner>,
}

/// 结构职责：记录部分下载与远端资源的对应关系。
/// 约束条件：地址、签名或 ETag 任一变化都必须丢弃旧字节；缺少 ETag 时不能续传。
#[derive(Serialize, Deserialize)]
struct PartialMeta {
    url: String,
    signature: String,
    etag: Option<String>,
    total: Option<u64>,
}

struct DownloadOutcome {
    received: u64,
    total: Option<u64>,
}

/// 区分可重试的传输失败和不可继续的协议错误。
/// discard 只表示已写入字节不可再用，与是否允许用户重试无关。
#[derive(Debug)]
struct DownloadError {
    message: String,
    retryable: bool,
    discard: bool,
}

impl DownloadError {
    fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
            discard: false,
        }
    }

    fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            discard: false,
        }
    }

    fn corrupt(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            discard: true,
        }
    }
}

fn state_error() -> String {
    "更新状态不可用。".into()
}

/// 函数职责：检查更新源并保存可安装的候选。
/// 输入说明：更新地址和签名公钥来自应用配置，不接受前端传入。
/// 输出说明：无更新返回 None；检查失败保留可重试的原始原因。
#[tauri::command]
pub async fn desktop_update_check(
    app: AppHandle,
    state: State<'_, DesktopUpdateState>,
) -> Result<Option<UpdateInfo>, String> {
    let token = {
        let mut inner = state.inner.lock().map_err(|_| state_error())?;
        inner.generation += 1;
        let stale = inner.session.take();
        let token = inner.generation;
        drop(inner);
        if let Some(session) = stale {
            remove_session_files(&session);
        }
        token
    };
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let Some(update) = update else {
        return Ok(None);
    };
    let directory = updates_dir(&app)?;
    let stem = format!(
        "{}-{}",
        path_component(&update.version),
        path_component(&update.target)
    );
    let partial = directory.join(format!("{stem}.part"));
    let meta = directory.join(format!("{stem}.json"));
    cleanup_stale(&directory, &partial, &meta);
    let info = UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        body: update.body.clone(),
    };
    let mut inner = state.inner.lock().map_err(|_| state_error())?;
    if inner.generation != token {
        remove_file(&partial);
        remove_file(&meta);
        return Err("更新操作已取消。".into());
    }
    inner.session = Some(Session {
        generation: token,
        update,
        partial,
        meta,
        verified: false,
    });
    Ok(Some(info))
}

/// 函数职责：下载当前候选并校验签名。
/// 输入说明：必须先成功检查并保存候选。
/// 输出说明：通过 Channel 发送累计进度；缓存文件保留到关闭或安装。
/// 实现思路：优先复用已校验文件；否则从部分文件续传，签名通过后才标记可安装。
#[tauri::command]
pub async fn desktop_update_download(
    app: AppHandle,
    state: State<'_, DesktopUpdateState>,
    on_event: Channel<UpdateProgress>,
) -> Result<(), String> {
    let (token, update, partial, meta, verified) = {
        let inner = state.inner.lock().map_err(|_| state_error())?;
        let session = inner
            .session
            .as_ref()
            .ok_or_else(|| "请先检查更新。".to_string())?;
        (
            session.generation,
            session.update.clone(),
            session.partial.clone(),
            session.meta.clone(),
            session.verified,
        )
    };
    if verified {
        if let Ok(size) = file_size(&partial) {
            send_progress(&on_event, size, Some(size));
            return Ok(());
        }
        // 缓存被外部清理时回退到重新下载，不把缺失文件当成不可恢复的安装错误。
    }
    // 完整文件可能残留续传记录；先按签名识别，避免向已完成的文件发起越界范围请求。
    if let Some(size) = verified_cache(&app, &update, &partial, &meta)? {
        mark_verified(&state, token)?;
        send_progress(&on_event, size, Some(size));
        return Ok(());
    }
    let outcome = match download_with_retry(
        &update.download_url,
        &update.signature,
        &partial,
        &meta,
        &on_event,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            if error.discard {
                remove_file(&partial);
                remove_file(&meta);
            }
            return Err(error.message);
        }
    };
    let bytes = fs::read(&partial).map_err(|error| format!("无法读取更新安装包：{error}"))?;
    if let Err(error) = verify_signature(&app, &bytes, &update) {
        remove_file(&partial);
        remove_file(&meta);
        return Err(error);
    }
    mark_verified(&state, token)?;
    remove_file(&meta);
    send_progress(
        &on_event,
        outcome.received,
        outcome.total.or(Some(outcome.received)),
    );
    Ok(())
}

/// 函数职责：把已验证的安装包交给平台安装器。
/// 输入说明：必须已有通过签名校验的完整文件。
/// 输出说明：Windows 安装器接管后进程退出；其他平台返回后由前端重启。
/// 实现思路：安装前重新校验缓存文件，避免下载完成后文件被替换。
#[tauri::command]
pub async fn desktop_update_install(
    app: AppHandle,
    state: State<'_, DesktopUpdateState>,
) -> Result<(), String> {
    let (token, update, partial) = {
        let inner = state.inner.lock().map_err(|_| state_error())?;
        let session = inner
            .session
            .as_ref()
            .ok_or_else(|| "请先下载更新。".to_string())?;
        if !session.verified {
            return Err("请先下载更新。".into());
        }
        (
            session.generation,
            session.update.clone(),
            session.partial.clone(),
        )
    };
    let bytes = fs::read(&partial).map_err(|error| format!("无法读取更新安装包：{error}"))?;
    verify_signature(&app, &bytes, &update)?;
    {
        let inner = state.inner.lock().map_err(|_| state_error())?;
        if inner.generation != token {
            return Err("更新操作已取消。".into());
        }
    }
    update
        .install(&bytes)
        .map_err(|error| format!("无法安装更新：{error}"))
}

/// 函数职责：释放候选并删除未交给安装器的缓存文件。
/// 输入说明：可重复调用，不影响已经启动的系统安装器。
/// 输出说明：后续旧命令因序号不符被拒绝。
#[tauri::command]
pub fn desktop_update_close(state: State<'_, DesktopUpdateState>) -> Result<(), String> {
    let session = {
        let mut inner = state.inner.lock().map_err(|_| state_error())?;
        inner.generation += 1;
        inner.session.take()
    };
    if let Some(session) = session {
        remove_session_files(&session);
    }
    Ok(())
}

fn mark_verified(state: &State<'_, DesktopUpdateState>, token: u64) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| state_error())?;
    if inner.generation != token {
        return Err("更新操作已取消。".into());
    }
    if let Some(session) = inner.session.as_mut() {
        session.verified = true;
    }
    Ok(())
}

/// 读取已有缓存并校验；通过签名即视为完整安装包，不依赖续传记录判断长度。
/// 校验失败时保留带记录的部分文件供续传；没有记录的残留字节无法安全定位，直接清理。
fn verified_cache(
    app: &AppHandle,
    update: &Update,
    partial: &Path,
    meta: &Path,
) -> Result<Option<u64>, String> {
    if !partial.is_file() {
        return Ok(None);
    }
    let size = file_size(partial)?;
    if size == 0 {
        return Ok(None);
    }
    let bytes = fs::read(partial).map_err(|error| format!("无法读取更新安装包：{error}"))?;
    if verify_signature(app, &bytes, update).is_ok() {
        remove_file(meta);
        return Ok(Some(size));
    }
    if !meta.exists() {
        remove_file(partial);
    }
    Ok(None)
}

async fn download_with_retry(
    url: &reqwest::Url,
    signature: &str,
    partial: &Path,
    meta: &Path,
    channel: &Channel<UpdateProgress>,
) -> Result<DownloadOutcome, DownloadError> {
    let mut last = None;
    for round in 0..ATTEMPTS {
        match download_once(url, signature, partial, meta, channel).await {
            Ok(outcome) => return Ok(outcome),
            Err(error) if error.retryable && round + 1 < ATTEMPTS => {
                last = Some(error);
                tokio::time::sleep(RETRY_BASE_DELAY * (round as u32 + 1)).await;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last.unwrap_or_else(|| DownloadError::retryable(NETWORK_MESSAGE)))
}

/// 函数职责：执行一轮范围请求并把响应追加到部分文件。
/// 输入说明：部分文件、元数据必须属于当前候选；每轮都会重新读取文件长度。
/// 输出说明：服务端忽略范围请求或资源变化时从头重写，传输中断由外层重试。
/// 实现思路：仅在存在 ETag 时携带 Range 和 If-Range，并校验 206 的起始偏移与总长度。
async fn download_once(
    url: &reqwest::Url,
    signature: &str,
    partial: &Path,
    meta: &Path,
    channel: &Channel<UpdateProgress>,
) -> Result<DownloadOutcome, DownloadError> {
    let previous =
        read_meta(meta).filter(|saved| saved.url == url.as_str() && saved.signature == signature);
    let mut received = fs::metadata(partial).map(|value| value.len()).unwrap_or(0);
    if previous.is_none() || received == 0 {
        truncate(partial)?;
        received = 0;
    }
    // 没有 ETag 就无法确认服务端返回的是同一份资源，只能从零开始。
    let resume = previous
        .as_ref()
        .filter(|saved| received > 0 && saved.etag.is_some());
    ensure_crypto_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| DownloadError::fatal(format!("无法创建更新连接：{error}")))?;
    let mut request = client
        .get(url.clone())
        .header(ACCEPT, "application/octet-stream")
        .header(
            USER_AGENT,
            format!("Taskrail/{}", env!("CARGO_PKG_VERSION")),
        );
    if let Some(saved) = resume {
        request = request
            .header(RANGE, format!("bytes={received}-"))
            .header(IF_RANGE, saved.etag.clone().unwrap_or_default());
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| DownloadError::retryable(NETWORK_MESSAGE))?;
    let status = response.status();
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        truncate(partial)?;
        remove_file(meta);
        return Err(DownloadError::retryable(NETWORK_MESSAGE));
    }
    let resumed = status == StatusCode::PARTIAL_CONTENT;
    if !resumed && status != StatusCode::OK {
        return Err(DownloadError::fatal(format!(
            "更新服务器返回 HTTP {}。",
            status.as_u16()
        )));
    }
    if !resumed {
        // 服务端忽略 Range 或资源已变化：丢弃旧字节，从零重写。
        truncate(partial)?;
        received = 0;
    }
    let total = response_total(&response, resumed, received)?;
    if resumed {
        let start = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(content_range_start)
            .ok_or_else(|| DownloadError::fatal("更新续传响应缺少范围信息。"))?;
        if start != received {
            truncate(partial)?;
            remove_file(meta);
            return Err(DownloadError::corrupt("更新续传位置不匹配。"));
        }
        if let (Some(previous_total), Some(next_total)) =
            (resume.and_then(|saved| saved.total), total)
        {
            if previous_total != next_total {
                truncate(partial)?;
                remove_file(meta);
                return Err(DownloadError::retryable(NETWORK_MESSAGE));
            }
        }
    }
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| resume.and_then(|saved| saved.etag.clone()));
    write_meta(
        meta,
        &PartialMeta {
            url: url.to_string(),
            signature: signature.to_owned(),
            etag,
            total,
        },
    )?;
    if let Some(total) = total {
        if received > total {
            truncate(partial)?;
            remove_file(meta);
            return Err(DownloadError::corrupt("安装包大小不匹配。"));
        }
        if received == total {
            send_progress(channel, received, Some(total));
            return Ok(DownloadOutcome {
                received,
                total: Some(total),
            });
        }
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(partial)
        .map_err(|error| DownloadError::fatal(format!("无法写入更新安装包：{error}")))?;
    send_progress(channel, received, total);
    let mut last_progress = Instant::now();
    loop {
        let chunk = tokio::time::timeout(CHUNK_TIMEOUT, response.chunk())
            .await
            .map_err(|_| DownloadError::retryable(NETWORK_MESSAGE))?
            .map_err(|_| DownloadError::retryable(NETWORK_MESSAGE))?;
        let Some(chunk) = chunk else {
            break;
        };
        file.write_all(&chunk)
            .map_err(|error| DownloadError::fatal(format!("无法写入更新安装包：{error}")))?;
        received += chunk.len() as u64;
        if let Some(total) = total {
            if received > total {
                return Err(DownloadError::corrupt("安装包大小不匹配。"));
            }
        }
        if last_progress.elapsed() >= PROGRESS_INTERVAL {
            last_progress = Instant::now();
            send_progress(channel, received, total);
        }
    }
    if let Some(total) = total {
        if received != total {
            return Err(DownloadError::retryable("安装包下载不完整。"));
        }
    }
    send_progress(channel, received, total);
    Ok(DownloadOutcome { received, total })
}

/// 解析 206 响应 `Content-Range` 的起始偏移；缺失或格式非法时返回 None。
fn content_range_start(header: &str) -> Option<u64> {
    header
        .strip_prefix("bytes ")?
        .split_once('-')?
        .0
        .parse()
        .ok()
}

/// 计算完整资源的总字节数。206 的 Content-Length 只覆盖剩余部分，因此要加上已写字节。
fn response_total(
    response: &reqwest::Response,
    resumed: bool,
    received: u64,
) -> Result<Option<u64>, DownloadError> {
    if resumed {
        if let Some(total) = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(content_range_total)
        {
            return Ok(Some(total));
        }
    }
    let length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    Ok(match (length, resumed) {
        (Some(length), true) => received.checked_add(length),
        (Some(length), false) => Some(length),
        (None, _) => None,
    })
}

fn content_range_total(header: &str) -> Option<u64> {
    header.split_once('/')?.1.parse().ok()
}

fn send_progress(channel: &Channel<UpdateProgress>, downloaded: u64, total: Option<u64>) {
    let _ = channel.send(UpdateProgress {
        downloaded_bytes: downloaded,
        total_bytes: total,
    });
}

/// reqwest 使用 rustls-no-provider 时要求进程内已安装加密提供者；与更新插件保持同一实现。
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("updates");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建更新缓存目录：{error}"))?;
    Ok(directory)
}

/// 只保留当前候选的缓存；旧版本的部分文件和元数据不能无限占用磁盘。
fn cleanup_stale(directory: &Path, partial: &Path, meta: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == partial || path == meta || !path.is_file() {
            continue;
        }
        if matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("part" | "json")
        ) {
            remove_file(&path);
        }
    }
}

fn path_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn read_meta(path: &Path) -> Option<PartialMeta> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_meta(path: &Path, meta: &PartialMeta) -> Result<(), DownloadError> {
    let bytes = serde_json::to_vec(meta)
        .map_err(|error| DownloadError::fatal(format!("无法记录更新续传状态：{error}")))?;
    fs::write(path, bytes)
        .map_err(|error| DownloadError::fatal(format!("无法记录更新续传状态：{error}")))
}

fn truncate(path: &Path) -> Result<(), DownloadError> {
    fs::write(path, [])
        .map_err(|error| DownloadError::fatal(format!("无法创建更新安装包：{error}")))
}

fn remove_file(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("无法删除更新缓存 {}: {error}", path.display());
        }
    }
}

fn remove_session_files(session: &Session) {
    remove_file(&session.partial);
    remove_file(&session.meta);
}

fn file_size(path: &Path) -> Result<u64, String> {
    fs::metadata(path)
        .map(|value| value.len())
        .map_err(|error| format!("无法读取更新安装包：{error}"))
}

/// 校验安装包签名，并确保签名中的版本与候选版本一致。
/// 更新清单本身不签名，只有把签名版本与清单版本绑定才能阻止降级替换。
fn verify_signature(app: &AppHandle, data: &[u8], update: &Update) -> Result<(), String> {
    let (pubkey, require_signed_version) = updater_key(app)?;
    let public_key = PublicKey::decode(&decode_base64(&pubkey)?)
        .map_err(|_| "更新公钥格式无效。".to_string())?;
    let signature = Signature::decode(&decode_base64(&update.signature)?)
        .map_err(|_| "更新签名格式无效。".to_string())?;
    public_key
        .verify(data, &signature, true)
        .map_err(|_| "更新安装包签名校验失败。".to_string())?;
    verify_signed_version(
        signature.trusted_comment(),
        &update.version,
        require_signed_version,
    )
}

fn updater_key(app: &AppHandle) -> Result<(String, bool), String> {
    let config = app.config();
    let updater = config
        .plugins
        .0
        .get("updater")
        .ok_or_else(|| "更新配置缺失。".to_string())?;
    let pubkey = updater
        .get("pubkey")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "更新公钥缺失。".to_string())?
        .to_owned();
    let require_signed_version = updater
        .get("requireSignedVersion")
        .or_else(|| updater.get("require-signed-version"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    Ok((pubkey, require_signed_version))
}

fn decode_base64(value: &str) -> Result<String, String> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| "更新签名格式无效。".to_string())?;
    String::from_utf8(bytes).map_err(|_| "更新签名格式无效。".to_string())
}

fn verify_signed_version(comment: &str, announced: &str, required: bool) -> Result<(), String> {
    let Some(signed) = comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
    else {
        return if required {
            Err("更新签名缺少版本信息。".into())
        } else {
            Ok(())
        };
    };
    if signed.trim_start_matches('v') == announced.trim_start_matches('v') {
        Ok(())
    } else {
        Err("更新签名版本与候选版本不一致。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_offsets_and_totals_are_parsed() {
        assert_eq!(content_range_start("bytes 1024-2047/4096"), Some(1024));
        assert_eq!(content_range_total("bytes 1024-2047/4096"), Some(4096));
        assert_eq!(content_range_start("invalid"), None);
        assert_eq!(content_range_total("bytes 0-10/*"), None);
    }

    #[test]
    fn signed_version_must_match_announced_version() {
        assert!(verify_signed_version("timestamp:1\tversion:0.8.2", "0.8.2", true).is_ok());
        assert!(verify_signed_version("timestamp:1\tversion:v0.8.2", "0.8.2", true).is_ok());
        assert!(verify_signed_version("timestamp:1\tversion:0.8.1", "0.8.2", true).is_err());
        assert!(verify_signed_version("timestamp:1", "0.8.2", true).is_err());
        assert!(verify_signed_version("timestamp:1", "0.8.2", false).is_ok());
    }

    #[test]
    fn interrupted_download_resumes_from_written_bytes() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        const PAYLOAD: &[u8] = b"taskrail-update-payload-0123456789";
        const CUT: usize = 13;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut round = 0;
            while round < 2 {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let mut buffer = [0u8; 4096];
                        let count = stream.read(&mut buffer).unwrap();
                        let request =
                            String::from_utf8_lossy(&buffer[..count]).to_ascii_lowercase();
                        if round == 0 {
                            // 第一轮声明完整长度但只写一半就断开，模拟传输中断。
                            write!(
                                stream,
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"v1\"\r\n\r\n",
                                PAYLOAD.len()
                            )
                            .unwrap();
                            stream.write_all(&PAYLOAD[..CUT]).unwrap();
                        } else {
                            let range = request
                                .lines()
                                .find_map(|line| line.strip_prefix("range: "))
                                .map(str::trim);
                            let if_range = request
                                .lines()
                                .find_map(|line| line.strip_prefix("if-range: "))
                                .map(str::trim);
                            assert_eq!(range, Some(format!("bytes={CUT}-").as_str()));
                            assert_eq!(if_range, Some("\"v1\""));
                            let body = &PAYLOAD[CUT..];
                            write!(
                                stream,
                                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nETag: \"v1\"\r\n\r\n",
                                body.len(),
                                CUT,
                                PAYLOAD.len() - 1,
                                PAYLOAD.len()
                            ).unwrap();
                            stream.write_all(body).unwrap();
                        }
                        stream.flush().unwrap();
                        round += 1;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "更新下载没有发起续传请求");
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("本地更新服务器失败：{error}"),
                }
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let partial = directory.path().join("update.part");
        let meta = directory.path().join("update.json");
        let url: reqwest::Url = format!("http://{address}/update.exe").parse().unwrap();
        let channel = Channel::new(|_| Ok(()));
        let outcome = tauri::async_runtime::block_on(download_with_retry(
            &url,
            "signature",
            &partial,
            &meta,
            &channel,
        ))
        .expect("中断后应完成续传");
        server.join().unwrap();
        assert_eq!(fs::read(&partial).unwrap(), PAYLOAD);
        assert_eq!(outcome.received, PAYLOAD.len() as u64);
        assert_eq!(outcome.total, Some(PAYLOAD.len() as u64));
    }

    #[test]
    fn server_ignoring_range_rewrites_from_zero() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        const PAYLOAD: &[u8] = b"taskrail-update-payload-0123456789";
        const CUT: usize = 13;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let count = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..count]).to_ascii_lowercase();
            assert!(
                request.lines().any(|line| line.starts_with("range: ")),
                "应先尝试续传"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                PAYLOAD.len()
            )
            .unwrap();
            stream.write_all(PAYLOAD).unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let partial = directory.path().join("update.part");
        let meta = directory.path().join("update.json");
        fs::write(&partial, &PAYLOAD[..CUT]).unwrap();
        let url: reqwest::Url = format!("http://{address}/update.exe").parse().unwrap();
        write_meta(
            &meta,
            &PartialMeta {
                url: url.to_string(),
                signature: "signature".into(),
                etag: Some("\"v1\"".into()),
                total: Some(PAYLOAD.len() as u64),
            },
        )
        .unwrap();
        let channel = Channel::new(|_| Ok(()));
        let outcome = tauri::async_runtime::block_on(download_once(
            &url,
            "signature",
            &partial,
            &meta,
            &channel,
        ))
        .expect("服务端忽略范围请求时应从头重写");
        server.join().unwrap();
        assert_eq!(fs::read(&partial).unwrap(), PAYLOAD);
        assert_eq!(outcome.received, PAYLOAD.len() as u64);
    }
}
