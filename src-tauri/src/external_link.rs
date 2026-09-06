//! 文件职责：约束从 Markdown 跳转到系统外部程序的链接。
//! 定义范围：外部 URL 与本地文档打开范围校验，不读取或渲染文档正文。
use crate::storage::{self, FileError};
use std::path::Path;

/// 函数职责：验证可交给系统默认程序的外部链接。
/// 输入说明：链接来自 Markdown，必须视为不可信文本。
/// 输出说明：仅返回合法的 HTTP、HTTPS 或非空 mailto 地址；其他协议返回 LINK_BLOCKED。
/// 实现思路：使用 URL 解析器验证协议和目标，避免前缀判断放行本地文件或脚本协议。
pub fn validated_url(input: &str) -> Result<String, FileError> {
    let parsed =
        url::Url::parse(input).map_err(|_| FileError::new("LINK_BLOCKED", "链接地址无效。"))?;
    let allowed = match parsed.scheme() {
        "http" | "https" => parsed.host_str().is_some(),
        "mailto" => !parsed.path().is_empty(),
        _ => false,
    };
    if !allowed {
        return Err(FileError::new(
            "LINK_BLOCKED",
            "仅允许打开网页或电子邮件链接。",
        ));
    }
    Ok(parsed.into())
}

/// 函数职责：验证可交由系统默认应用打开的本地文档或目录。
/// 输入说明：路径由应用相对资源解析得到，但仍须在原生边界校验存在性与目标类型。
/// 输出说明：仅返回规范化的现存目录或允许扩展名的普通文件；脚本、可执行文件与其他目标返回 LINK_BLOCKED。
/// 实现思路：复用文件层规范路径，检查真实目标的元数据和扩展名，并拒绝 Windows 备用数据流路径。
pub fn validated_local_document(path: &Path) -> Result<String, FileError> {
    #[cfg(windows)]
    if path.components().any(|component| matches!(component, std::path::Component::Normal(name) if name.to_string_lossy().contains(':'))) {
        return Err(FileError::new("LINK_BLOCKED", "不能通过文档链接打开 Windows 备用数据流。"));
    }
    let canonical = storage::canonical_path(path, false)?;
    let target = Path::new(&canonical);
    let metadata = std::fs::metadata(target).map_err(FileError::io)?;
    if metadata.is_dir() {
        return Ok(canonical);
    }
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let allowed = [
        "md", "markdown", "txt", "pdf", "docx", "xlsx", "csv", "json", "toml", "yaml", "yml",
        "png", "jpg", "jpeg", "gif", "webp", "svg",
    ];
    if !metadata.is_file() || !allowed.contains(&extension.as_str()) {
        return Err(FileError::new(
            "LINK_BLOCKED",
            "仅允许打开目录或支持的文档、图片文件；不允许执行程序或脚本。",
        ));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn only_web_and_nonempty_email_urls_can_leave_the_app() {
        assert!(validated_url("https://example.com/docs?q=one").is_ok());
        assert!(validated_url("mailto:example@example.com").is_ok());
        for input in [
            "javascript:alert(1)",
            "file:///C:/Windows",
            "data:text/html,hi",
            "cmd:calc",
            "mailto:",
            "./local.md",
            "not a url",
        ] {
            assert_eq!(validated_url(input).unwrap_err().code, "LINK_BLOCKED");
        }
    }
    #[test]
    fn local_document_paths_accept_existing_directories_and_known_document_types() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("子目录")).unwrap();
        let normalized_directory = storage::canonical_path(directory.path(), false).unwrap();
        assert_eq!(
            validated_local_document(&directory.path().join("子目录").join("..")).unwrap(),
            normalized_directory
        );
        for extension in [
            "md", "markdown", "txt", "pdf", "docx", "xlsx", "csv", "json", "toml", "yaml", "yml",
            "png", "jpg", "jpeg", "gif", "webp", "svg", "MD",
        ] {
            let document = directory.path().join(format!("中文 文档.{extension}"));
            fs::write(&document, b"test fixture").unwrap();
            assert_eq!(
                validated_local_document(&document).unwrap(),
                storage::canonical_path(&document, false).unwrap()
            );
        }
    }
    #[test]
    fn local_document_paths_reject_missing_executable_script_and_shortcut_targets() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            validated_local_document(&directory.path().join("missing.md"))
                .unwrap_err()
                .code,
            "FILE_NOT_FOUND"
        );
        for filename in [
            "run.exe",
            "run.ps1",
            "run.cmd",
            "run.bat",
            "run.js",
            "run.vbs",
            "shortcut.lnk",
            "shortcut.url",
            "run.scr",
            "run.com",
            "run.msi",
            "page.html",
            "README",
            "document.md.exe",
        ] {
            let document = directory.path().join(filename);
            fs::write(&document, b"must never execute").unwrap();
            assert_eq!(
                validated_local_document(&document).unwrap_err().code,
                "LINK_BLOCKED"
            );
        }
    }
    #[cfg(windows)]
    #[test]
    fn windows_alternate_stream_cannot_disguise_an_executable_as_markdown() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("program.exe"), b"must never execute").unwrap();
        let stream = directory.path().join("program.exe:notes.md");
        fs::write(&stream, b"alternate stream").unwrap();
        assert_eq!(
            validated_local_document(&stream).unwrap_err().code,
            "LINK_BLOCKED"
        );
    }
    #[cfg(unix)]
    #[test]
    fn markdown_symlink_to_executable_uses_the_real_target_extension() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("run.sh");
        let alias = directory.path().join("document.md");
        fs::write(&executable, b"must never execute").unwrap();
        std::os::unix::fs::symlink(&executable, &alias).unwrap();
        assert_eq!(
            validated_local_document(&alias).unwrap_err().code,
            "LINK_BLOCKED"
        );
    }
}
