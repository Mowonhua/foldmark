//! 文件职责：在 Markdown 同目录的 .assets 中保存并校验不可变图片。
//! 定义范围：图片引用、原子落盘、受限读取与完整文档包的二进制文件访问。
use crate::storage::{self, FileError};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_BUNDLE_BYTES: usize = 128 * 1024 * 1024;

/// 结构职责：保存与 TypeScript 端相同的内容寻址引用。
/// 字段说明：id 为 SHA-256，path 必须为 .assets/id.ext，created 是毫秒时间戳。
/// 约束条件：只允许静态 PNG、JPEG、WebP，不接受任意附件路径。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasAsset {
    pub id: String,
    pub path: String,
    pub mime_type: String,
    pub size: usize,
    pub created: f64,
}

/// 结构职责：提供二进制图片上传的路径与格式元数据。
/// 字段说明：字段在 ASCII 请求头中按 encodeURIComponent(JSON.stringify(value)) 编码。
/// 约束条件：只接受固定字段；实际路径与格式校验仍由 put 执行。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetUploadMetadata {
    pub document_path: String,
    pub mime_type: String,
}

/// 结构职责：提供系统选择的二进制导出目标；附件字节不进入 JSON。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportUploadMetadata {
    pub path: String,
}

/// 函数职责：解码原生二进制请求的 ASCII 元数据头。
/// 输入说明：encoded 为 encodeURIComponent 后的 JSON，限制头大小并拒绝额外字段。
/// 输出说明：返回强类型元数据；编码、UTF-8 或字段错误时拒绝磁盘操作。
/// 实现思路：先检查 URI 字符集合，再严格还原百分号编码和 UTF-8，最后解码 JSON 字段。
pub fn decode_upload_metadata<T: serde::de::DeserializeOwned>(
    encoded: &str,
) -> Result<T, FileError> {
    if encoded.is_empty() || encoded.len() > 16 * 1024 || !encoded.is_ascii() {
        return Err(invalid("二进制请求元数据头无效。"));
    }
    let bytes = encoded.as_bytes();
    let mut offset = 0;
    while offset < bytes.len() {
        let byte = bytes[offset];
        if byte == b'%' {
            if offset + 2 >= bytes.len()
                || !bytes[offset + 1..offset + 3]
                    .iter()
                    .all(u8::is_ascii_hexdigit)
            {
                return Err(invalid("二进制请求元数据百分号编码无效。"));
            }
            offset += 3;
            continue;
        }
        // 与 encodeURIComponent 的未转义集合一致；原始 +、&、= 不能改变路径语义。
        if !byte.is_ascii_alphanumeric() && !b"-_.!~*'()".contains(&byte) {
            return Err(invalid("二进制请求元数据必须使用百分号编码。"));
        }
        offset += 1;
    }
    let decoded = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| invalid("二进制请求元数据不是有效 UTF-8。"))?;
    serde_json::from_str(&decoded).map_err(|_| invalid("二进制请求元数据字段无效。"))
}

/// 函数职责：在进入后台线程前取得受限的二进制请求快照。
/// 输入说明：只接受 Raw 请求体，最大值由图片或完整包调用方传入。
/// 输出说明：拒绝 JSON 数字数组、空请求及过大请求，成功返回独立字节。
/// 实现思路：先检查请求体类型和长度，再复制到后台线程拥有的缓冲区。
pub fn upload_bytes(body: &tauri::ipc::InvokeBody, maximum: usize) -> Result<Vec<u8>, FileError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = body else {
        return Err(invalid("附件必须通过二进制请求体传输。"));
    };
    if bytes.is_empty() || bytes.len() > maximum {
        return Err(invalid("二进制请求数据大小无效。"));
    }
    Ok(bytes.clone())
}

/// 函数职责：先完整校验图片，再原子创建不可变附件。
/// 输入说明：document 指向父目录已存在的 Markdown，bytes 不超过 20 MiB。
/// 输出说明：重复内容复用现存文件及创建时间；损坏或链接目标不覆盖。
/// 实现思路：校验格式与摘要，刷新同目录临时文件，再以不覆盖方式提交。
pub fn put(document: &Path, bytes: &[u8], mime_type: &str) -> Result<CanvasAsset, FileError> {
    let extension = validate_image(bytes, mime_type)?;
    let id = storage::fingerprint(bytes);
    let mut asset = CanvasAsset {
        path: format!(".assets/{id}.{extension}"),
        id,
        mime_type: mime_type.into(),
        size: bytes.len(),
        created: 0.0,
    };
    let directory = assets_directory(document, true)?;
    let path = directory.join(asset.path.strip_prefix(".assets/").unwrap());
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            read(document, &asset)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut temporary =
                tempfile::NamedTempFile::new_in(&directory).map_err(FileError::io)?;
            temporary.write_all(bytes).map_err(FileError::io)?;
            temporary.as_file().sync_all().map_err(FileError::io)?;
            // 提交前复验目录，应用自己的写入通过 FileState 串行；目标始终不可覆盖。
            if assets_directory(document, false)? != directory {
                return Err(invalid("画布附件目录已变化。"));
            }
            if let Err(error) = temporary.persist_noclobber(&path) {
                if error.error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(FileError::io(error.error));
                }
                read(document, &asset)?;
            }
            sync_parent(&path)?;
        }
        Err(error) => return Err(FileError::io(error)),
    }
    asset.created = checked_file(&path)?
        .modified()
        .map_err(FileError::io)?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64;
    Ok(asset)
}

/// 函数职责：读取并校验引用的图片原始字节。
/// 输入说明：引用只允许同目录 .assets 的内容寻址文件。
/// 输出说明：缺失、格式不匹配、越界、链接和摘要错误均失败，不修改原文件。
/// 实现思路：验证引用和路径，执行有上限读取，再比较大小及 SHA-256。
pub fn read(document: &Path, asset: &CanvasAsset) -> Result<Vec<u8>, FileError> {
    validate_asset(asset)?;
    let directory = assets_directory(document, false)?;
    let path = directory.join(asset.path.strip_prefix(".assets/").unwrap());
    let bytes = read_limited(&path, MAX_IMAGE_BYTES)?;
    validate_image(&bytes, &asset.mime_type)?;
    if bytes.len() != asset.size || storage::fingerprint(&bytes) != asset.id {
        return Err(invalid("画布图片已损坏或摘要不匹配。"));
    }
    Ok(bytes)
}

/// 函数职责：原子保存系统对话框选中的完整文档包或画布图片。
/// 输入说明：path 由前端系统对话框返回，内容不超过 128 MiB。
/// 输出说明：写入失败时旧文件保持完整；不跟随最终文件的链接。
/// 实现思路：刷新同目录临时文件并原子替换选定路径。
pub fn save_bundle(path: &Path, bytes: &[u8]) -> Result<(), FileError> {
    if bytes.is_empty() || bytes.len() > MAX_BUNDLE_BYTES {
        return Err(invalid("完整文档包不能超过 128 MiB。"));
    }
    let parent = checked_parent(path)?;
    match fs::symlink_metadata(path) {
        Ok(_) => {
            checked_file(path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(FileError::io(error)),
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(FileError::io)?;
    temporary.write_all(bytes).map_err(FileError::io)?;
    temporary.as_file().sync_all().map_err(FileError::io)?;
    temporary
        .persist(path)
        .map_err(|error| FileError::io(error.error))?;
    sync_parent(path)
}

/// 函数职责：有上限地读取完整文档 ZIP。
/// 输入说明：path 为用户选择的现存文件，ZIP 内容校验由前端导入器完成。
/// 输出说明：文件过大或最终目标为链接时拒绝读取。
/// 实现思路：先检查文件元数据，再读取最多限制加一个字节。
pub fn read_bundle(path: &Path) -> Result<Vec<u8>, FileError> {
    checked_parent(path)?;
    read_limited(path, MAX_BUNDLE_BYTES)
}

fn invalid(message: &str) -> FileError {
    FileError::new("CANVAS_ASSET_INVALID", message)
}

fn extension(mime_type: &str) -> Result<&'static str, FileError> {
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        _ => Err(invalid("仅支持 PNG、JPEG 和 WebP 图片。")),
    }
}

fn validate_asset(asset: &CanvasAsset) -> Result<(), FileError> {
    let ext = extension(&asset.mime_type)?;
    let valid_id = asset.id.len() == 64
        && asset
            .id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    let valid_path = asset.path == format!(".assets/{}.{ext}", asset.id);
    if !valid_id
        || !valid_path
        || asset.size == 0
        || asset.size > MAX_IMAGE_BYTES
        || !asset.created.is_finite()
        || asset.created < 0.0
    {
        return Err(invalid("画布图片引用无效。"));
    }
    Ok(())
}

fn validate_image(bytes: &[u8], mime_type: &str) -> Result<&'static str, FileError> {
    let extension = extension(mime_type)?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(invalid("单张图片不能超过 20 MiB。"));
    }
    let matches = match mime_type {
        "image/png" => bytes.len() >= 24 && bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => bytes.len() >= 4 && bytes.starts_with(&[255, 216, 255]),
        "image/webp" => {
            bytes.len() >= 16 && bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
        }
        _ => false,
    };
    if !matches {
        return Err(invalid("图片格式与文件内容不匹配。"));
    }
    Ok(extension)
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Windows junction 也属于重解析点，不能只检查普通符号链接。
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn checked_parent(path: &Path) -> Result<PathBuf, FileError> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(invalid("文档必须使用有效的绝对文件路径。"));
    }
    fs::canonicalize(path.parent().ok_or_else(|| invalid("文档目录无效。"))?).map_err(FileError::io)
}

fn assets_directory(document: &Path, create: bool) -> Result<PathBuf, FileError> {
    let parent = checked_parent(document)?;
    let directory = parent.join(".assets");
    if create {
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(FileError::io(error)),
        }
    }
    let metadata = fs::symlink_metadata(&directory).map_err(FileError::io)?;
    if is_link(&metadata)
        || !metadata.is_dir()
        || fs::canonicalize(&directory).map_err(FileError::io)? != directory
    {
        return Err(invalid("画布附件目录不能是链接或位于文档目录外。"));
    }
    Ok(directory)
}

fn checked_file(path: &Path) -> Result<fs::Metadata, FileError> {
    let metadata = fs::symlink_metadata(path).map_err(FileError::io)?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err(invalid("不能读取目录或链接附件。"));
    }
    Ok(metadata)
}

/** 元数据检查后仍限制实际读取量，避免文件在读取期间增长造成无上限分配。 */
fn read_limited(path: &Path, maximum: usize) -> Result<Vec<u8>, FileError> {
    let metadata = checked_file(path)?;
    if metadata.len() > maximum as u64 {
        return Err(invalid("附件或完整文档包过大。"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .map_err(FileError::io)?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(FileError::io)?;
    if bytes.len() > maximum {
        return Err(invalid("附件或完整文档包过大。"));
    }
    Ok(bytes)
}

fn sync_parent(path: &Path) -> Result<(), FileError> {
    #[cfg(unix)]
    fs::File::open(path.parent().unwrap())
        .and_then(|directory| directory.sync_all())
        .map_err(FileError::io)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> Vec<u8> {
        let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10];
        bytes.extend_from_slice(&[0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
        bytes
    }

    #[test]
    fn binary_upload_metadata_roundtrips_unicode_and_rejects_malformed_headers() {
        let encoded = "%7B%22documentPath%22%3A%22D%3A%2F%E9%A1%B9%E7%9B%AE%2F%E5%9B%BE%20%26%20%2B.md%22%2C%22mimeType%22%3A%22image%2Fpng%22%7D";
        let metadata: AssetUploadMetadata = decode_upload_metadata(encoded).unwrap();
        assert_eq!(metadata.document_path, "D:/项目/图 & +.md");
        assert_eq!(metadata.mime_type, "image/png");
        for invalid in [
            "",
            "%ZZ",
            "%FF",
            "{\"path\":\"D:/raw\"}",
            "%7B%22path%22%3A%22D%3A%2Fout%22%2C%22extra%22%3Atrue%7D",
        ] {
            assert!(
                decode_upload_metadata::<ExportUploadMetadata>(invalid).is_err(),
                "必须拒绝 {invalid}"
            );
        }
        assert!(
            decode_upload_metadata::<ExportUploadMetadata>(&"a".repeat(16 * 1024 + 1)).is_err()
        );
        let raw = tauri::ipc::InvokeBody::Raw(png());
        assert_eq!(upload_bytes(&raw, MAX_IMAGE_BYTES).unwrap(), png());
        assert!(upload_bytes(
            &tauri::ipc::InvokeBody::Json(serde_json::json!([1, 2, 3])),
            MAX_IMAGE_BYTES
        )
        .is_err());
        assert!(upload_bytes(&raw, 4).is_err());
    }

    #[test]
    fn repeated_import_shares_directory_and_preserves_bytes_and_creation() {
        let root = tempfile::tempdir().unwrap();
        let first = put(&root.path().join("one.md"), &png(), "image/png").unwrap();
        let again = put(&root.path().join("two.md"), &png(), "image/png").unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(first.created, again.created);
        assert_eq!(
            read(&root.path().join("renamed.md"), &first).unwrap(),
            png()
        );
        assert!(root.path().join(".assets").is_dir());
    }

    #[test]
    fn rejects_path_escape_mime_spoof_and_keeps_corrupt_attachment_untouched() {
        let root = tempfile::tempdir().unwrap();
        let document = root.path().join("notes.md");
        assert!(put(&document, &png(), "image/jpeg").is_err());
        assert!(put(&document, &vec![0; MAX_IMAGE_BYTES + 1], "image/png").is_err());
        let asset = put(&document, &png(), "image/png").unwrap();
        for path in [
            "../escape.png".to_string(),
            root.path()
                .join("absolute.png")
                .to_string_lossy()
                .into_owned(),
            format!(".assets/../{}.png", asset.id),
        ] {
            let mut forged = asset.clone();
            forged.path = path;
            assert!(read(&document, &forged).is_err());
        }
        let mut corrupt = png();
        corrupt[23] ^= 1;
        let stored = root.path().join(&asset.path);
        fs::write(&stored, &corrupt).unwrap();
        assert!(read(&document, &asset).is_err());
        assert!(put(&document, &png(), "image/png").is_err());
        assert_eq!(fs::read(stored).unwrap(), corrupt);
    }

    #[test]
    fn rejects_attachment_directory_links_without_writing_outside() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = root.path().join(".assets");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        #[cfg(windows)]
        {
            // Junction 无需开发者模式或管理员权限，与普通符号链接具有相同的逃逸风险。
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(outside.path())
                .output()
                .unwrap();
            assert!(
                status.status.success(),
                "无法建立测试 junction: {:?}",
                status
            );
        }
        assert!(put(&root.path().join("notes.md"), &png(), "image/png").is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn exports_binary_atomically_and_reads_with_size_limit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("canvas.png");
        save_bundle(&path, &png()).unwrap();
        assert_eq!(read_bundle(&path).unwrap(), png());
        let file = fs::File::create(root.path().join("oversized.zip")).unwrap();
        file.set_len(MAX_BUNDLE_BYTES as u64 + 1).unwrap();
        assert!(read_bundle(&root.path().join("oversized.zip")).is_err());
        assert_eq!(read_bundle(&path).unwrap(), png());
    }
}
