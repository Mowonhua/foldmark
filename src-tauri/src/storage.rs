//! 文件职责：实现与 UI 无关的可靠 UTF-8 文件持久化。
//! 定义范围：磁盘快照、稳定错误码、原子保存和配置恢复存储。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::path::PathBuf;
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

/// 函数职责：把用户选择的文件归一为不含目录别名的稳定绝对路径。
/// 输入说明：新文件仅允许最终文件名缺失，父目录必须已存在。
/// 输出说明：Windows 返回普通盘符或 UNC 路径，避免扩展路径前缀产生重复关联。
/// 实现思路：现存文件解析目标；新文件解析父目录后拼接最终文件名。
pub fn canonical_path(path: &Path, create: bool) -> Result<String, FileError> {
    let resolved = match fs::canonicalize(path) {
        Ok(resolved) => resolved,
        Err(error) if create && error.kind() == std::io::ErrorKind::NotFound => {
            let name = path
                .file_name()
                .ok_or_else(|| FileError::new("FILE_PATH", "文件名无效。"))?;
            let parent = path
                .parent()
                .filter(|value| !value.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            fs::canonicalize(parent).map_err(FileError::io)?.join(name)
        }
        Err(error) => return Err(FileError::io(error)),
    };
    let identity = resolved.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(unc) = identity.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{unc}"));
        }
        if let Some(local) = identity.strip_prefix(r"\\?\") {
            return Ok(local.to_owned());
        }
    }
    Ok(identity)
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

/// 函数职责：提供恢复文件命名与草稿归属校验共同使用的路径身份。
/// 输入说明：路径来自已关联文件；即使文件暂时缺失也必须能计算身份。
/// 输出说明：Windows 忽略大小写并统一分隔符，不要求再次访问主文件。
/// 实现思路：保持与已有恢复键一致的字符串归一化规则。
pub fn file_identity(path: &str) -> String {
    let identity = path.replace('\\', "/");
    #[cfg(windows)]
    let identity = identity.to_lowercase();
    identity
}

/// 函数职责：读取可选文件的完整字节，并严格区分缺失与 IO 错误。
/// 输入说明：路径可以位于尚未创建的应用状态目录。
/// 输出说明：仅 NotFound 返回 None，其他错误原样映射为稳定文件错误。
/// 实现思路：共用一次原始字节读取，供配置和恢复校验解码。
pub fn read_optional_bytes(path: &Path) -> Result<Option<Vec<u8>>, FileError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(FileError::io(error)),
    }
}

/// 函数职责：在原文件同目录永久保留一份不可覆盖的损坏字节备份。
/// 输入说明：bytes 是此次已读取的原始内容，不重新序列化；原文件在本函数中只读。
/// 输出说明：成功返回唯一备份路径，失败不删除或覆盖原文件。
/// 实现思路：排他创建带 corrupt 标记的随机名称文件，刷新内容后保留为永久备份。
pub fn backup_corrupt_bytes(path: &Path, bytes: &[u8]) -> Result<PathBuf, FileError> {
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut backup = tempfile::Builder::new()
        .prefix(".foldmark.corrupt-")
        .suffix(".backup")
        .tempfile_in(parent)
        .map_err(FileError::io)?;
    backup.write_all(bytes).map_err(FileError::io)?;
    backup.as_file().sync_all().map_err(FileError::io)?;
    // keep 只保留本次排他创建的随机路径，不通过覆盖式 persist 复用任何已有备份名。
    let (_file, backup_path) = backup.keep().map_err(|error| FileError::io(error.error))?;
    sync_parent(&backup_path)?;
    Ok(backup_path)
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

/// 编辑器使用 LF；磁盘的未改动行必须保留各自换行，不能因保存而重排混合 CRLF/LF 的原文。
/// 替换行沿用对应旧行的换行，新插入行采用邻近旧行；正文没有末尾换行时不补换行。
fn preserve_newlines(original: &str, normalized: &str) -> String {
    if !original.contains("\r\n") {
        return normalized.to_owned();
    }
    let old_normalized = original.replace("\r\n", "\n");
    if !original.replace("\r\n", "").contains('\n') {
        return normalized.replace('\n', "\r\n");
    }
    let old_lines: Vec<&str> = original.split_inclusive('\n').collect();
    let new_lines: Vec<&str> = normalized.split_inclusive('\n').collect();
    let diff = similar::TextDiff::from_lines(old_normalized.as_str(), normalized);
    let mut output = String::with_capacity(normalized.len() + old_lines.len());
    for operation in diff.ops() {
        let old_range = operation.old_range();
        for (offset, new_index) in operation.new_range().enumerate() {
            let old_index = (old_range.start + offset)
                .min(old_range.end.saturating_sub(1))
                .min(old_lines.len().saturating_sub(1));
            let old_line = old_lines.get(old_index).copied().unwrap_or("");
            if operation.tag() == similar::DiffTag::Equal {
                output.push_str(old_line);
                continue;
            }
            let new_line = new_lines[new_index];
            if old_line.ends_with("\r\n") {
                output.push_str(&new_line.replace('\n', "\r\n"));
                continue;
            }
            output.push_str(new_line);
        }
    }
    output
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
    let body = preserve_newlines(
        original_text
            .strip_prefix('\u{feff}')
            .unwrap_or(original_text),
        &normalized,
    );
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
    let Some(bytes) = read_optional_bytes(path)? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| FileError::new("STATE_INVALID", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_identity_resolves_parent_segments_for_existing_and_new_files() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("nested")).unwrap();
        let path = directory.path().join("tasks.md");
        let alias = directory.path().join("nested").join("..").join("tasks.md");
        assert_eq!(
            canonical_path(&path, true).unwrap(),
            canonical_path(&alias, true).unwrap()
        );
        create(&path, "tasks").unwrap();
        assert_eq!(
            canonical_path(&path, false).unwrap(),
            canonical_path(&alias, false).unwrap()
        );
    }
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
    fn saving_a_mixed_newline_document_only_changes_the_edited_line() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mixed.md");
        std::fs::write(&path, "# 标题\r\n- [ ] one\n- [ ] two\r\nend").unwrap();
        let original = read(&path).unwrap();
        let unchanged = write(&path, &original.text, &original.revision).unwrap();
        assert_eq!(unchanged.revision, original.revision);
        write(
            &path,
            "# 标题\n- [x] one\n- [ ] two\nend",
            &unchanged.revision,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# 标题\r\n- [x] one\n- [ ] two\r\nend"
        );
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
