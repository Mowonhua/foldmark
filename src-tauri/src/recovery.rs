//! 文件职责：校验恢复草稿并隔离不可用的原始恢复数据。
//! 定义范围：恢复 DTO、路径归属校验、损坏备份和活动草稿的读写清理。
use crate::storage::{self, FileError};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 结构职责：记录单一文档尚未写回主文件的原始文本。
/// 字段说明：path 标识所属文件；baseRevision 只用于磁盘冲突判断；savedAt 是毫秒时间戳。
/// 约束条件：文本允许为空；路径与基线不为空；时间戳必须为 JavaScript 可精确表示的非负整数。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDraft {
    pub path: String,
    pub text: String,
    pub base_revision: String,
    pub saved_at: u64,
}

/// 函数职责：验证恢复数据的类型、字段边界和所属文档。
/// 输入说明：value 来自磁盘或前端；requested_path 来自当前项目关联。
/// 输出说明：仅返回符合契约且路径归属一致的草稿，错误不改变磁盘。
/// 实现思路：先通过 DTO 反序列化，再检查字段边界及统一的路径身份。
pub fn validate(
    value: serde_json::Value,
    requested_path: &str,
) -> Result<RecoveryDraft, FileError> {
    let draft: RecoveryDraft = serde_json::from_value(value).map_err(|error| {
        FileError::new("RECOVERY_INVALID", format!("恢复草稿字段格式无效：{error}"))
    })?;
    if draft.path.trim().is_empty()
        || draft.base_revision.trim().is_empty()
        || draft.saved_at > 9_007_199_254_740_991
    {
        return Err(FileError::new(
            "RECOVERY_INVALID",
            "恢复草稿路径、基线或时间戳超出允许范围。",
        ));
    }
    if storage::file_identity(&draft.path) != storage::file_identity(requested_path) {
        return Err(FileError::new(
            "RECOVERY_INVALID",
            "恢复草稿属于另一文件，不能应用到当前文档。",
        ));
    }
    Ok(draft)
}

/// 备份刷新完成之前绝不移除活动数据；复验原始字节避免把备份期间新写入的内容一并删除。
/// 如果无法完成隔离，原文件和已经生成的备份都保留，调用方不能继续覆盖活动路径。
fn quarantine_invalid(path: &Path, bytes: &[u8], reason: &str) -> FileError {
    let backup = match storage::backup_corrupt_bytes(path, bytes) {
        Ok(backup) => backup,
        Err(error) => {
            return FileError::new(
                "RECOVERY_BACKUP_FAILED",
                format!(
                    "恢复草稿损坏，但无法完成备份；原草稿保留在 {}。原因：{}",
                    path.display(),
                    error.message
                ),
            )
        }
    };
    match storage::read_optional_bytes(path) {
        Ok(Some(current)) if current == bytes => {}
        _ => {
            return FileError::new(
                "RECOVERY_QUARANTINE_FAILED",
                format!(
                    "恢复草稿备份位于 {}，但活动文件已变化或不可读取，未执行删除。",
                    backup.display()
                ),
            )
        }
    }
    if let Err(error) = std::fs::remove_file(path) {
        return FileError::new(
            "RECOVERY_QUARANTINE_FAILED",
            format!(
                "恢复草稿备份位于 {}，但无法移出原活动文件 {}：{}",
                backup.display(),
                path.display(),
                error
            ),
        );
    }
    FileError::new(
        "RECOVERY_INVALID",
        format!("{reason} 原始数据已完整保留在备份：{}。", backup.display()),
    )
}

/// 函数职责：读取草稿，隔离损坏字节并向调用方明确报告。
/// 输入说明：recovery_path 是应用私有活动草稿路径；requested_path 是关联的 Markdown 路径。
/// 输出说明：仅原来缺失返回 None；损坏备份成功返回 RECOVERY_INVALID 并给出备份位置。
/// 实现思路：读取完整字节后校验，失败先持久保存唯一备份，确认活动文件未变化后再移出活动路径。
pub fn load(
    recovery_path: &Path,
    requested_path: &str,
) -> Result<Option<RecoveryDraft>, FileError> {
    let Some(bytes) = storage::read_optional_bytes(recovery_path)? else {
        return Ok(None);
    };
    let decoded = serde_json::from_slice(&bytes)
        .map_err(|error| {
            FileError::new(
                "RECOVERY_INVALID",
                format!("恢复草稿不是有效 JSON：{error}"),
            )
        })
        .and_then(|value| validate(value, requested_path));
    match decoded {
        Ok(draft) => Ok(Some(draft)),
        Err(error) => Err(quarantine_invalid(recovery_path, &bytes, &error.message)),
    }
}

/// 函数职责：写入通过校验的新草稿，并保护任何尚未隔离的损坏活动数据。
/// 输入说明：草稿路径必须与 DTO 路径对应，且调用方将同文档请求串行化。
/// 输出说明：遇到已有损坏草稿时先隔离并报错，下一次调用才写入新草稿；备份永不覆盖。
/// 实现思路：复用加载校验，再使用文件层的原子 JSON 保存。
pub fn save(recovery_path: &Path, draft: &RecoveryDraft) -> Result<(), FileError> {
    let value = serde_json::to_value(draft)
        .map_err(|error| FileError::new("RECOVERY_INVALID", error.to_string()))?;
    validate(value.clone(), &draft.path)?;
    load(recovery_path, &draft.path)?;
    storage::save_json(recovery_path, &value)
}

/// 函数职责：只清除有效的活动草稿，不删除已隔离的损坏备份。
/// 输入说明：请求文档身份必须与活动草稿一致，缺失允许重复清除。
/// 输出说明：损坏时先隔离并明确报错；备份失败则保留原活动数据。
/// 实现思路：复用加载校验后移除活动文件，所有备份文件保持独立生命周期。
pub fn clear(recovery_path: &Path, requested_path: &str) -> Result<(), FileError> {
    if load(recovery_path, requested_path)?.is_none() {
        return Ok(());
    }
    match std::fs::remove_file(recovery_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(FileError::io(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn draft() -> RecoveryDraft {
        RecoveryDraft {
            path: "D:/测试清单.md".into(),
            text: "尚未保存\n".into(),
            base_revision: "baseline".into(),
            saved_at: 123,
        }
    }
    fn backups(directory: &Path) -> Vec<std::path::PathBuf> {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".corrupt-")
            })
            .collect()
    }
    #[test]
    fn invalid_json_is_backed_up_verbatim_before_new_draft_and_clear() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("draft.json");
        let corrupt = b"{\"text\":\"unfinished\xff";
        fs::write(&path, corrupt).unwrap();
        let error = load(&path, &draft().path).unwrap_err();
        assert_eq!(error.code, "RECOVERY_INVALID");
        let protected = backups(directory.path());
        assert_eq!(protected.len(), 1);
        assert_eq!(fs::read(&protected[0]).unwrap(), corrupt);
        assert!(error.message.contains(&protected[0].display().to_string()));
        assert!(!path.exists());
        save(&path, &draft()).unwrap();
        assert_eq!(load(&path, &draft().path).unwrap(), Some(draft()));
        clear(&path, &draft().path).unwrap();
        assert_eq!(fs::read(&protected[0]).unwrap(), corrupt);
    }
    #[test]
    fn invalid_schema_and_wrong_file_identity_each_receive_unique_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("draft.json");
        let cases = [
            serde_json::json!({"path": "D:/测试清单.md", "text": 7, "baseRevision": "base", "savedAt": 1}),
            serde_json::json!({"path": "D:/测试清单.md", "text": "text", "baseRevision": "", "savedAt": 1}),
            serde_json::json!({"path": "D:/测试清单.md", "text": "text", "baseRevision": "base", "savedAt": -1}),
            serde_json::json!({"path": "D:/测试清单.md", "text": "text", "baseRevision": "base", "savedAt": 1.5}),
            serde_json::json!({"path": "D:/测试清单.md", "text": "text", "baseRevision": "base", "savedAt": 9007199254740992_u64}),
            serde_json::json!({"path": "D:/另一清单.md", "text": "text", "baseRevision": "base", "savedAt": 1}),
            serde_json::json!({"path": "D:/测试清单.md", "text": "text", "baseRevision": "base"}),
        ];
        let mut originals = Vec::new();
        for value in cases {
            let bytes = serde_json::to_vec(&value).unwrap();
            fs::write(&path, &bytes).unwrap();
            assert_eq!(
                load(&path, &draft().path).unwrap_err().code,
                "RECOVERY_INVALID"
            );
            originals.push(bytes);
        }
        let protected = backups(directory.path());
        assert_eq!(protected.len(), originals.len());
        for original in originals {
            assert!(protected
                .iter()
                .any(|backup| fs::read(backup).unwrap() == original));
        }
    }
    #[test]
    fn clear_and_save_cannot_bypass_quarantine_of_unread_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("draft.json");
        fs::write(&path, b"corrupt before clear").unwrap();
        assert_eq!(
            clear(&path, &draft().path).unwrap_err().code,
            "RECOVERY_INVALID"
        );
        fs::write(&path, b"corrupt before save").unwrap();
        assert_eq!(save(&path, &draft()).unwrap_err().code, "RECOVERY_INVALID");
        assert!(!path.exists());
        save(&path, &draft()).unwrap();
        clear(&path, &draft().path).unwrap();
        assert_eq!(backups(directory.path()).len(), 2);
    }
    #[test]
    fn only_missing_recovery_is_none_and_empty_text_is_valid() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing").join("draft.json");
        assert!(load(&path, &draft().path).unwrap().is_none());
        let mut empty = draft();
        empty.text.clear();
        save(&path, &empty).unwrap();
        assert_eq!(load(&path, &empty.path).unwrap(), Some(empty));
        assert!(load(directory.path(), &draft().path).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_path_casing_and_separators_do_not_change_recovery_ownership() {
        let value = serde_json::to_value(draft()).unwrap();
        assert!(validate(value, "d:\\测试清单.md").is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn locked_source_keeps_original_when_quarantine_cannot_finish() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("draft.json");
        fs::write(&path, b"broken").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        let error = load(&path, &draft().path).unwrap_err();
        assert_eq!(error.code, "RECOVERY_QUARANTINE_FAILED");
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        assert_eq!(backups(directory.path()).len(), 1);
        drop(lock);
    }

    #[cfg(windows)]
    #[test]
    fn denied_backup_creation_preserves_original_bytes_and_reports_failure() {
        use std::os::windows::process::CommandExt;
        fn directory_acl(path: &Path, operation: &str, entry: &str) -> bool {
            std::process::Command::new("icacls")
                .arg(path)
                .args([operation, entry])
                .creation_flags(0x08000000)
                .output()
                .expect("Windows icacls 必须可用于临时目录权限测试")
                .status
                .success()
        }
        struct RestoreTemporaryAcl<'a>(&'a Path);
        impl Drop for RestoreTemporaryAcl<'_> {
            fn drop(&mut self) {
                directory_acl(self.0, "/remove:d", "*S-1-1-0");
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("draft.json");
        fs::write(&path, b"only surviving corrupt bytes").unwrap();
        // 只禁止本测试新建临时目录中的文件创建，不继承到现有草稿；退出作用域恢复此测试添加的拒绝项。
        assert!(directory_acl(directory.path(), "/deny", "*S-1-1-0:(WD)"));
        let restore = RestoreTemporaryAcl(directory.path());
        let result = load(&path, &draft().path);
        let original = fs::read(&path).unwrap();
        drop(restore);
        let error = result.unwrap_err();
        assert_eq!(error.code, "RECOVERY_BACKUP_FAILED");
        assert_eq!(original, b"only surviving corrupt bytes");
        assert!(path.exists());
        assert!(backups(directory.path()).is_empty());
    }
}
