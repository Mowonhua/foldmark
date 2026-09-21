// 文件职责：生成桌面平台资源；定义范围：Tauri 构建入口。
fn main() {
    // 图标会编入 Windows 可执行文件；仅替换资源时也必须重新生成，避免增量构建保留旧图标。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build()
}
