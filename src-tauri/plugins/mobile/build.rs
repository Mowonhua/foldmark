fn main() {
    tauri_plugin::Builder::new(&["scan", "prepare", "activate"])
        .android_path("android")
        .build();
}
