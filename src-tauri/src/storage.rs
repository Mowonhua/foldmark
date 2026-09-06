//! 文件职责：实现与 UI 无关的可靠 UTF-8 文件持久化。
//! 定义范围：磁盘快照、稳定错误码、原子保存和配置恢复存储。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::{fs, io::Write};

/// 结构职责：返回已读取字节的文本与内容基线。
/// 字段说明：revision 覆盖 BOM 和换行字节，text 不含 BOM 且统一 LF，供编辑器比较。
/// 约束条件：只接受合法 UTF-8，不替换或丢弃非法字节。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSnapshot {
    pub path: String,
    pub text: String,
    pub revision: String,
}

/// 结构职责：向调用方提供可稳定分支处理的错误。
/// 字段说明：code 与本地语言无关，message 包含操作诊断。
/// 约束条件：冲突不得写入目标文件。
#[derive(Debug, Clone, Serialize)]
pub struct FileError {
    pub code: &'static str,
    pub message: String,
}

impl FileError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn io(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "FILE_NOT_FOUND",
            std::io::ErrorKind::PermissionDenied => "FILE_PERMISSION",
            std::io::ErrorKind::AlreadyExists => "FILE_EXISTS",
            _ => "FILE_IO",
        };
        Self::new(code, error.to_string())
    }
}

/// 内容指纹来自完整原始字节；恢复草稿键复用相同散列以避免路径字符进入文件名。
pub fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn snapshot(path: &Path, bytes: &[u8]) -> Result<FileSnapshot, FileError> {
    let body = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let text = std::str::from_utf8(body)
        .map_err(|error| FileError::new("FILE_ENCODING", error.to_string()))?;
    Ok(FileSnapshot {
        path: path.to_string_lossy().into_owned(),
        text: text.replace("\r\n", "\n"),
        revision: fingerprint(bytes),
    })
}

/// 临时文件必须与目标同目录，写完先刷新内容再替换，避免跨卷重命名和部分正文可见。
fn staged_file(path: &Path, bytes: &[u8]) -> Result<tempfile::NamedTempFile, FileError> {
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(FileError::io)?;
    temporary.write_all(bytes).map_err(FileError::io)?;
    temporary.as_file().sync_all().map_err(FileError::io)?;
    Ok(temporary)
}

/// 文件内容在替换前已刷新；Unix 再刷新目录项。Windows 使用 tempfile 的原子 MoveFileEx 替换。
fn sync_parent(path: &Path) -> Result<(), FileError> {
    #[cfg(unix)]
    fs::File::open(path.parent().unwrap_or(Path::new(".")))
        .and_then(|directory| directory.sync_all())
        .map_err(FileError::io)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// 函数职责：读取现存文件与其内容指纹。
/// 输入说明：path 为用户关联的原文件路径。
/// 输出说明：缺失、权限和编码错误独立报告。
/// 实现思路：一次读取原始字节，再解码与计算指纹。
pub fn read(path: &Path) -> Result<FileSnapshot, FileError> {
    snapshot(path, &fs::read(path).map_err(FileError::io)?)
}

/// 函数职责：在匹配磁盘基线时原子替换正文。
/// 输入说明：expected_revision 必须来自最近成功读取或保存。
/// 输出说明：冲突不修改原文件，成功返回实际落盘快照。
/// 实现思路：保留编码标记和换行，刷新同目录临时文件后复验基线并替换。
pub fn write(path: &Path, text: &str, expected_revision: &str) -> Result<FileSnapshot, FileError> {
    let original = fs::read(path).map_err(FileError::io)?;
    if fingerprint(&original) != expected_revision {
        return Err(FileError::new(
            "FILE_CONFLICT",
            "磁盘文件已变化，保留未保存内容。",
        ));
    }
    let original_text = std::str::from_utf8(&original)
        .map_err(|error| FileError::new("FILE_ENCODING", error.to_string()))?;
    let normalized = text.replace("\r\n", "\n");
    let crlf = original_text.contains("\r\n") && !original_text.replace("\r\n", "").contains('\n');
    let body = if crlf {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };
    let mut bytes = Vec::with_capacity(body.len() + 3);
    if original.starts_with(&[0xef, 0xbb, 0xbf]) {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(body.as_bytes());
    let temporary = staged_file(path, &bytes)?;
    // 临时文件写入耗时期间外部程序仍可能改写目标，因此不能仅依赖进入函数时的比较。
    if fingerprint(&fs::read(path).map_err(FileError::io)?) != expected_revision {
        return Err(FileError::new("FILE_CONFLICT", "保存期间磁盘文件已变化。"));
    }
    temporary
        .persist(path)
        .map_err(|error| FileError::io(error.error))?;
    sync_parent(path)?;
    snapshot(path, &bytes)
}

/// 函数职责：创建新清单，拒绝覆盖任何已有文件。
/// 输入说明：父目录必须已存在，text 为 UTF-8 文本。
/// 输出说明：成功返回快照，已有路径返回 FILE_EXISTS。
/// 实现思路：刷新同目录临时文件并使用不覆盖提交。
pub fn create(path: &Path, text: &str) -> Result<FileSnapshot, FileError> {
    let temporary = staged_file(path, text.as_bytes())?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| FileError::io(error.error))?;
    sync_parent(path)?;
    snapshot(path, text.as_bytes())
}

/// 函数职责：原子写入应用私有 JSON 状态。
/// 输入说明：目录由应用数据目录派生，不接收任意配置路径。
/// 输出说明：失败时原配置继续存在。
/// 实现思路：复用已刷新临时文件的原子替换能力。
pub fn save_json(path: &Path, value: &serde_json::Value) -> Result<(), FileError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(FileError::io)?;
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| FileError::new("STATE_INVALID", error.to_string()))?;
    staged_file(path, &bytes)?
        .persist(path)
        .map_err(|error| FileError::io(error.error))?;
    sync_parent(path)
}

/// 函数职责：读取可选的应用私有 JSON 状态。
/// 输入说明：路径来自配置或恢复数据目录。
/// 输出说明：仅缺失返回 None；损坏和权限错误不伪装为空配置。
/// 实现思路：读取后解析 JSON，独立映射错误。
pub fn load_json(path: &Path) -> Result<Option<serde_json::Value>, FileError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(FileError::io(error)),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| FileError::new("STATE_INVALID", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_preserves_bom_crlf_and_returns_lf_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("中文清单.md");
        std::fs::write(&path, b"\xef\xbb\xbf- [ ] old\r\n").unwrap();
        let original = read(&path).unwrap();
        assert_eq!(original.text, "- [ ] old\n");
        let saved = write(&path, "- [x] 完成\n", &original.revision).unwrap();
        assert_eq!(saved.text, "- [x] 完成\n");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            "\u{feff}- [x] 完成\r\n".as_bytes()
        );
        assert_ne!(saved.revision, original.revision);
    }
    #[test]
    fn stale_snapshot_and_external_edit_never_overwrite_disk() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("list.md");
        let original = create(&path, "first").unwrap();
        let saved = write(&path, "second", &original.revision).unwrap();
        assert_eq!(
            write(&path, "stale", &original.revision).unwrap_err().code,
            "FILE_CONFLICT"
        );
        std::fs::write(&path, "external").unwrap();
        assert_eq!(
            write(&path, "third", &saved.revision).unwrap_err().code,
            "FILE_CONFLICT"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "external");
    }
    #[test]
    fn create_refuses_existing_file_and_invalid_utf8_is_reported() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("list.md");
        create(&path, "first").unwrap();
        assert_eq!(
            create(&path, "replacement").unwrap_err().code,
            "FILE_EXISTS"
        );
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        assert_eq!(read(&path).unwrap_err().code, "FILE_ENCODING");
    }
    #[test]
    fn recovery_survives_restart_and_corrupt_config_is_not_missing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recovery").join("draft.json");
        assert!(load_json(&path).unwrap().is_none());
        let draft = serde_json::json!({"path":"D:/中文.md", "text":"未保存", "baseRevision":"abc", "savedAt":123});
        save_json(&path, &draft).unwrap();
        assert_eq!(load_json(&path).unwrap(), Some(draft));
        std::fs::write(&path, "invalid").unwrap();
        assert_eq!(load_json(&path).unwrap_err().code, "STATE_INVALID");
    }
}
