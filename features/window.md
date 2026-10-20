# 桌面窗口

> 模块职责：Windows 窗口的原生材质与显示过渡。

## F-WIN-001 Windows 窗口材质与显示过渡

窗口保留整窗透明与系统 Acrylic，通过窗口级设置关闭 DWM 过渡。

创建提交：-

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src-tauri/src/lib.rs::run |
| 关键实现 | src-tauri/src/window_material.rs::disable_transitions |
| 关键实现 | src-tauri/src/window_material.rs::set_window_material |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 约束 | 主窗口首次显示前关闭 DWM 过渡，最小化与恢复期间保持该设置 | - |
| S-02 | 约束 | 关闭 DWM 过渡不改变整窗透明配置或系统 Acrylic 材质 | - |
| S-03 | 异常 | 主窗口缺失、句柄获取失败或 DWM 设置失败时，启动返回错误 | - |
| S-04 | 正常 | 从最小化恢复时，首个可见窗口画面应具有 Acrylic 背景 | - |
