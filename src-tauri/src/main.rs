// 文件职责：启动桌面进程；定义范围：Windows GUI 入口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    foldmark_lib::run()
}
