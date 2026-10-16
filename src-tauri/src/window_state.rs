//! 文件职责：启动时在窗口显示前恢复上次关闭的几何。
//! 定义范围：只读 config.json 的 window 字段；写入由前端关闭流程完成。
use serde::Deserialize;
use tauri::{Manager, PhysicalPosition, PhysicalSize};

/// 结构职责：镜像前端写入 config.json 的窗口几何。
/// 字段说明：坐标与尺寸为物理像素；坐标允许多显示器的负值。
/// 约束条件：maximized 单独出现表示上次最大化关闭，只恢复最大化不覆盖位置。
#[derive(Deserialize)]
struct WindowPlacement {
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    #[serde(default)]
    maximized: bool,
}

#[derive(Deserialize)]
struct PersistedWindow {
    window: Option<WindowPlacement>,
}

/// 函数职责：判断按该几何恢复后窗口顶部拖动区是否仍可触及。
/// 输入说明：几何为物理像素；工作区来自当前显示器枚举。
/// 输出说明：某台显示器与窗口横向重叠足够、且窗口顶边完整落在其工作区纵向范围内时为 true。
/// 实现思路：仅相交不够，拖到只露几像素或标题栏藏在屏幕外的窗口无法拖回，必须保证拖动区可命中。
fn grabbable(monitors: &[tauri::Monitor], x: i32, y: i32, width: i32) -> bool {
    monitors.iter().any(|monitor| {
        let area = monitor.work_area();
        let top = area.position.y;
        let bottom = top + area.size.height as i32;
        let overlap = (x + width).min(area.position.x + area.size.width as i32) - x.max(area.position.x);
        // 横向至少保留一段可命中的拖动区；顶边须在工作区内且下方至少露出一个标题栏高度。
        overlap >= width.min(160) && y >= top && y + 48 <= bottom
    })
}

/// 函数职责：把上次保存的普通模式几何应用到仍隐藏的主窗口。
/// 输入说明：setup 阶段调用，前端稍后自行显示窗口。
/// 输出说明：配置缺失、损坏或位置按可触及性检查通不过时保留配置默认居中。
/// 实现思路：先恢复尺寸，落点经显示器可触及性检查后恢复位置，最后应用最大化。
pub fn restore(app: &tauri::App) {
    let Ok(directory) = app.path().app_data_dir() else { return };
    let Ok(text) = std::fs::read_to_string(directory.join("config.json")) else { return };
    let Ok(PersistedWindow { window: Some(placement) }) = serde_json::from_str(&text) else { return };
    let Some(window) = app.get_webview_window("main") else { return };
    if let (Some(width), Some(height)) = (placement.width, placement.height) {
        let _ = window.set_size(PhysicalSize::new(width, height));
    }
    if let (Some(x), Some(y)) = (placement.x, placement.y) {
        // 显示器可能已拔掉或重排，窗口也可能被拖到只露边缘；拖动区不可触及时放弃恢复，避免窗口丢到屏外。
        let width = placement.width.unwrap_or(0) as i32;
        let reachable = window
            .available_monitors()
            .map(|monitors| grabbable(&monitors, x, y, width))
            .unwrap_or(false);
        if reachable {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }
    if placement.maximized {
        let _ = window.maximize();
    }
}
