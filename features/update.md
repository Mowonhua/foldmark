# 桌面应用更新

> 模块职责：桌面平台的版本检查、安装包续传下载、签名校验与系统安装交接。

## F-UPD-001 桌面应用更新

启动时按当前发布通道从固定 HTTPS 更新源检查较新版本，按偏好下载安装包，校验更新签名后保存文档并交给平台安装器。

创建提交：ae1a383

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src/lib/updater/tauri.ts::TauriUpdatePort |
| 关键实现 | src/lib/updater/update-coordinator.ts::UpdateCoordinator |
| 关键实现 | src-tauri/src/desktop_update.rs::desktop_update_check |
| 关键实现 | src-tauri/src/desktop_update.rs::desktop_update_download |
| 关键实现 | src-tauri/src/desktop_update.rs::download_once |
| 关键实现 | src-tauri/src/desktop_update.rs::desktop_update_install |
| 关键实现 | src-tauri/src/desktop_update.rs::desktop_update_close |
| 关键实现 | src-tauri/src/lib.rs::run |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 正常 | 按正式或预发布通道读取更新源，只有更高版本才产生候选；没有新版本时结束检查 | src/lib/updater/tauri.test.ts::原生没有新版本时返回 null |
| S-02 | 正常 | 默认自动下载但不自动安装，下载显示累计字节与实时速度 | src/lib/updater/tauri.test.ts::转发原生累计进度并等待下载命令完成, src/lib/updater/update-coordinator.test.ts::默认自动下载并保留累计进度\，但从不自动安装 |
| S-03 | 异常 | 传输中断时自动重连并携带 Range 与 If-Range 从已写入字节续传；服务端忽略范围请求或资源变化时丢弃旧字节从头重写 | src-tauri/src/desktop_update.rs::tests::interrupted_download_resumes_from_written_bytes, src-tauri/src/desktop_update.rs::tests::server_ignoring_range_rewrites_from_zero |
| S-04 | 约束 | 安装包必须通过更新签名校验，签名中的版本须与候选版本一致；安装前再次校验缓存文件 | src-tauri/src/desktop_update.rs::tests::signed_version_must_match_announced_version |
| S-05 | 正常 | 安装前保存全部文档；Windows 安装器接管后退出，其他平台安装后重启；重启失败重试不重复消费安装包 | src/lib/updater/tauri.test.ts::Windows 安装器负责退出和重启\，不再额外重启旧进程, src/lib/updater/tauri.test.ts::其他平台安装成功后重启\，重启失败重试不会重复消费安装包 |
| S-06 | 正常 | 关闭候选删除未交接的缓存；完整下载但未安装的文件在下次启动检查后可复用，无需重新下载 | - |
| S-07 | 约束 | 检查到新候选时清理其他版本的缓存；部分文件与 ETag 记录在重启后继续使用，续传记录中的地址、签名或 ETag 变化时丢弃旧字节，缺少 ETag 时从零开始 | - |
