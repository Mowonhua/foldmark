//! 文件职责：将窗口材质请求映射到当前调用窗口的原生效果。
//! 定义范围：材质命令参数、平台能力边界和 Tauri 命令适配。

use serde::Deserialize;
use tauri::{Theme, WebviewWindow};

/// 结构职责：限定前端可请求的窗口背景材质。
/// 字段说明：Opaque 与 Transparent 都清除原生效果，由前端分别绘制实色或透明背景；Blur 与 Acrylic 请求桌面内容模糊。
/// 约束条件：仅接受小写枚举值，不携带窗口标签或主题身份。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowMaterial {
    Opaque,
    Transparent,
    Blur,
    Acrylic,
}

/// 函数职责：为发起命令的窗口提交材质变更，不操作其他窗口。
/// 输入说明：window 由 Tauri 注入；material 限制为四种合法值，theme 为显式 light、dark 或跟随系统的 null。
/// 输出说明：true 表示原生调用完成，false 表示平台或版本不支持；调用错误返回可显示的字符串。
/// 实现思路：将原生调用送到主线程并异步等待结果，不把入队成功作为应用成功。
#[tauri::command]
pub async fn set_window_material(
    window: WebviewWindow,
    material: WindowMaterial,
    theme: Option<Theme>,
) -> Result<bool, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let result = apply_material(&target, material, theme);
            // 容量为一且仅发送一次；前端已关闭时接收端可能释放，无需重试原生操作。
            let _ = sender.try_send(result);
        })
        .map_err(|error| format!("无法调度窗口材质变更：{error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "窗口材质变更未返回结果。".to_owned())?
}

/// 函数职责：在主线程同步窗口明暗，清除前一材质并应用目标材质。
/// 输入说明：window 必须是调用命令所属窗口，theme 保留用户的明暗偏好，None 表示跟随系统；调用方必须保证主线程执行。
/// 输出说明：不支持目标材质返回 false；原生调用失败时清除效果并返回错误。
/// 实现思路：Windows 直接使用 window-vibrancy 的结果，其他平台仅支持无原生效果模式。
fn apply_material(
    window: &WebviewWindow,
    material: WindowMaterial,
    theme: Option<Theme>,
) -> Result<bool, String> {
    // 主线程的 set_theme 同步更新原生明暗后再应用材质，避免浅色网页沿用深色 Acrylic 底色。
    // 原生主题会同步 WebView 的 prefers-color-scheme；跟随系统必须传 None 解除显式覆盖，不能传已解析的明暗值。
    window
        .set_theme(theme)
        .map_err(|error| format!("无法同步窗口明暗：{error}"))?;
    #[cfg(target_os = "windows")]
    {
        clear_material(window)?;
        let result = match material {
            WindowMaterial::Opaque | WindowMaterial::Transparent => return Ok(true),
            WindowMaterial::Blur => window_vibrancy::apply_blur(window, None),
            WindowMaterial::Acrylic => window_vibrancy::apply_acrylic(window, None),
        };
        match result {
            Ok(()) => Ok(true),
            Err(error) => {
                // 前端仅在 true 时启用透明画布；失败后清理原生效果，使实色回退不遗留材质。
                clear_material(window)?;
                match error {
                    window_vibrancy::Error::UnsupportedPlatform(_)
                    | window_vibrancy::Error::UnsupportedPlatformVersion(_) => Ok(false),
                    _ => Err(format!("无法应用窗口材质：{error}")),
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Ok(matches!(
            material,
            WindowMaterial::Opaque | WindowMaterial::Transparent
        ))
    }
}

/// 函数职责：移除当前窗口可能残留的 Blur 和 Acrylic 材质。
/// 输入说明：调用方必须位于主线程。
/// 输出说明：无法支持的效果视为无需清除；其他原生错误保留为字符串。
/// 实现思路：两种效果都尝试清除，避免一种清理失败阻止另一种清理。
#[cfg(target_os = "windows")]
fn clear_material(window: &WebviewWindow) -> Result<(), String> {
    let results = [
        window_vibrancy::clear_blur(window),
        window_vibrancy::clear_acrylic(window),
    ];
    for result in results {
        match result {
            Ok(())
            | Err(window_vibrancy::Error::UnsupportedPlatform(_))
            | Err(window_vibrancy::Error::UnsupportedPlatformVersion(_)) => {}
            Err(error) => return Err(format!("无法清除窗口材质：{error}")),
        }
    }
    Ok(())
}
