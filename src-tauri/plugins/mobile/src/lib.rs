//! 手机专用能力：离线扫码与前台局域网发现权限。
use tauri::{plugin::{Builder, TauriPlugin}, Runtime};
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("foldmark-mobile").setup(|_, api| {
        api.register_android_plugin("app.foldmark.mobilebridge", "MobilePlugin")?;
        Ok(())
    }).build()
}
