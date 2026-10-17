fn main() {
    // JS 事件助手调用 snake_case 命令；移动分发在 ACL 检查后转为 Kotlin 的 camelCase 方法名。
    tauri_plugin::Builder::new(&["scan", "prepare", "activate", "checkUpdate", "downloadUpdate", "installUpdate", "closeUpdate", "register_listener", "remove_listener"])
        .android_path("android")
        .build();
}
