// 文件职责：生成桌面平台资源；定义范围：Tauri 构建入口。
fn main() {
    // 图标会编入 Windows 可执行文件；仅替换资源时也必须重新生成，避免增量构建保留旧图标。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri 的应用资源只附加到主程序；Rust 单元测试也使用命名导出的窗口子类 API，
        // 因此所有 Windows 链接目标都需要 Common Controls v6 的激活清单。
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        // 主程序已由 Tauri 嵌入清单；禁止链接器重复生成，保留 Tauri 原有清单与 v6 依赖。
        println!("cargo:rustc-link-arg-bin=foldmark=/MANIFEST:NO");
    }
}
