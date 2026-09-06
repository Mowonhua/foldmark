//! 文件职责：约束从 Markdown 跳转到系统外部程序的链接。
//! 定义范围：允许的 URL 协议校验，不处理文档内锚点或本地文件读取。
use crate::storage::FileError;

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

#[cfg(test)]
mod tests {
    use super::*;
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
}
