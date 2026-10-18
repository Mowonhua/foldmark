# 局域网同步

## F-SYN-001 版本交换与保守合并

同步所选正文和项目资料，按对端已知版本增量交换并以行级补丁压缩正文，使用共同祖先合并独立修改，保留有歧义的双方版本。

创建提交：-

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src/lib/sync/engine.ts::SyncEngine |
| 关键实现 | src/lib/sync/merge.ts::encodeDocument |
| 关键实现 | src/lib/session/sync-documents.ts::SessionSyncDocuments |
| 关键实现 | src/lib/editor/index.ts::EditorController.setSynchronizedText |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 正常 | 单端修改与不相交段落修改收敛到相同版本 | src/lib/sync/engine.test.ts::同步持久化 > 往返重复交换及独立修改最终收敛 |
| S-02 | 并发 | 相同文本范围修改或任务结构变化与并行修改保留冲突 | src/lib/sync/merge.test.ts::同步三方合并 > 任务归档排序删除与并行说明修改均保留冲突 |
| S-03 | 异常 | 断线、重复传输和重启不能重复应用或覆盖新修改 | src/lib/sync/engine.test.ts::同步持久化 > 写入后退出由日志恢复而不重复修改, src/lib/sync/engine.test.ts::同步持久化 > 处理冲突期间的新编辑使旧解决请求失效, scripts/test-paired-recovery.mjs::<module> |
| S-04 | 约束 | 外部文件修改、组合输入和受保护草稿阻止覆盖 | src/lib/session/sync-documents.test.ts::同步文档端口 > 外部改动和受保护草稿拒绝远端覆盖, src/lib/session/sync-documents.test.ts::同步文档端口 > 组合输入期间推迟同步且移除关联不删除文件 |
| S-05 | 约束 | 停止同步保留正文；删除手机项目仅清理本机私有文件，不传播删除，未知项目须明确接收 | src/lib/sync/engine.test.ts::同步持久化 > 暂停保留文件并拒绝远端覆盖, src/lib/session/sync-documents.test.ts::同步文档端口 > 取消接收不创建项目或文件 |
| S-06 | 异常 | 本机正文超限时保留可恢复的同步记录，缩小后继续交换 | src/lib/sync/engine.test.ts::同步持久化 > 本机正文超过上限后保留可加载的旧版本\，缩小正文后继续同步 |
| S-07 | 约束 | 更换配对前保留待接收正文及冲突副本 | src-tauri/src/sync.rs::tests::detached_pairing_preserves_pending_and_conflicting_versions |
| S-08 | 正常 | 重新配对可明确关联已有项目，不创建副本；不同正文先保留双方，重启后继续合并 | src/lib/sync/engine.test.ts::同步持久化 > 明确关联已有项目不创建副本且先保留双方内容\，重启后可合并 |
| S-09 | 约束 | 一个本机项目只能关联一个同步文档，项目不能关联到灵感簿 | src/lib/sync/engine.test.ts::同步持久化 > 拒绝关联已被占用的本机项目或把项目关联到灵感簿 |
| S-10 | 正常 | 取消选择撤回对端尚未接收的文档，重启及旧请求重传不能恢复提示，不删除已接收正文 | src/lib/sync/engine.test.ts::同步持久化 > 取消选择撤回尚未接收的文档\，重启和旧请求重传不恢复接收提示, src/lib/sync/engine.test.ts::同步持久化 > 取消选择不删除对端已接收的正文和关联, scripts/test-mobile-native-fixes.mjs::<module> |
| S-11 | 正常 | 收敛后交换不传输正文，修改以行级补丁发送；对端状态重建拒绝增量并以全量恢复 | src/lib/sync/engine.test.ts::同步持久化 > 收敛后交换不传输正文\，新修改只携带补丁, src/lib/sync/engine.test.ts::同步持久化 > 对端状态重建后拒绝增量并以全量恢复, src/lib/sync/merge.test.ts::同步三方合并 > 增量编码只传输未知版本\，补丁重建与全文结果一致, src/lib/sync/merge.test.ts::同步三方合并 > 拒绝不兼容协议篡改内容与缺失基线 |
| S-12 | 正常 | 本机输入防抖四百毫秒后通过长连接触发交换；传输期间新增输入快速跟进，对端通知不丢失；空闲仅兜底轮询，离线逐步退避，缺少增量基线时全量重试 | src/lib/sync/controller.test.ts::输入后防抖自动同步\，不等待轮询, src/lib/sync/controller.test.ts::长连接空闲仅兜底轮询\，离线逐步退避且新输入快速跟进, src/lib/sync/controller.test.ts::传输占用超过输入防抖时\，完成后四百毫秒内发送新输入, src/lib/sync/controller.test.ts::交换过程中收到电脑通知\，结束后立即跟进且不重复轮询, src/lib/sync/controller.test.ts::对端缺少增量基线时用全量版本重试一次 |
| S-13 | 约束 | 打开项目未修改时按基线指纹跳过重复读盘，远端写入仍按磁盘基线校验 | src/lib/session/sync-documents.test.ts::同步文档端口 > 打开项目未修改时按基线指纹跳过重复读盘 |
| S-14 | 正常 | 接收对端版本并成功保存后立即确认，失败时不确认；手机接收或合并新版本后立即回传，使电脑确认不等待下轮轮询；合并版本仍须得到对端确认 | src/lib/sync/engine.test.ts::同步持久化 > 收到对端版本并成功写入后立即确认\，写入失败不能确认, src/lib/sync/engine.test.ts::同步持久化 > 自动合并产生的新版本必须等待对端确认, src/lib/sync/controller.test.ts::前台空闲后电脑通知立即送达手机并完成双方确认 |
| S-15 | 正常 | 接收对端版本替换正文后保持视口顶部原文行与像素偏移，末尾追加、上方插入和上方删除均不跳动 | scripts/test-sync-scroll.mjs::<module> |

## F-SYN-002 设备配对与加密连接

一台电脑与一台手机通过短期二维码及电脑确认配对，以认证的加密连接交换文档。

创建提交：-

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src-tauri/src/sync.rs::sync_exchange |
| 关键实现 | src/lib/sync/controller.ts::SyncController |
| 关键实现 | src-tauri/src/sync/connection.rs::client |
| 关键实现 | src-tauri/src/sync/connection.rs::server |
| 关键实现 | src-tauri/plugins/mobile/android/src/main/java/PairingScannerActivity.kt::PairingScannerActivity |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 正常 | 配对后自动发现电脑并在前台同步，也可手动指定地址 | - |
| S-02 | 异常 | 无效凭证与已撤销设备拒绝交换；旧连接退出不能关闭新连接，已取消的建连不能安装 | src-tauri/src/sync.rs::tests::revoked_and_unrecognized_devices_cannot_authenticate, src-tauri/src/sync.rs::tests::replacing_connection_and_cancelling_connect_preserve_generation_boundaries |
| S-03 | 约束 | 配对信息与本机文件路径不进入普通文档同步数据 | scripts/test-native-lan.mjs::<module> |
| S-04 | 正常 | 配对证书压缩为二维码后字节保持一致，旧输入格式仍可读取 | src/lib/sync/pairing-code.test.ts::二维码压缩证书并保留全部字节\，旧手动格式仍能读取 |
| S-05 | 异常 | 原生权限拒绝显示具体原因，不能显示对象占位文字 | src/lib/sync/controller.test.ts::原生权限拒绝保留可读原因\，不显示对象占位文字 |
| S-06 | 正常 | 扫码界面竖屏取景，关闭和手电筒操作避开系统栏，识别二维码后返回 | - |
| S-07 | 正常 | 手机在前台建立已认证的 TLS 双向长连接，两端通过同一连接发送变更通知和文档交换；空闲读超时不破坏帧，保存错误不关闭连接，断线使待确认请求失败 | src-tauri/src/sync.rs::tests::tls_stream_reuses_connection_after_idle_and_delivers_both_directions, src-tauri/src/sync/connection.rs::tests::same_connection_delivers_desktop_wake_and_multiple_mobile_exchanges, src-tauri/src/sync/connection.rs::tests::partial_frame_survives_read_timeout_and_preserves_next_frame, src-tauri/src/sync/connection.rs::tests::disconnected_stream_rejects_pending_exchange |
| S-08 | 正常 | 电脑输入防抖后主动通知手机，手机退到后台释放连接，返回前台立即重连并交换；退到后台的旧同步任务不能继续建连 | src/lib/sync/controller.test.ts::电脑输入防抖后主动通知长连接\，手机进入后台释放连接, src/lib/sync/controller.test.ts::手机离开前台不启动连接\，前台确认后显示已同步, src/lib/sync/controller.test.ts::读取连接状态期间退到后台不再建连 |

## F-SYN-003 同步面板

桌面按区块呈现设备和文档，手机使用整页布局。冲突版本进入独立合并视图，连接设置按需展开。底部栏只提示需要用户处理的同步问题。

创建提交：-

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src/lib/SyncPanel.svelte::<module> |
| 关键实现 | src/lib/sync/controller.ts::SyncController.attention |
| 关键实现 | src/App.svelte::<module> |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 正常 | 两端正确呈现未配对、已配对、待接收、冲突及失败状态，滚动时关闭入口保持可见 | scripts/test-sync-ui.mjs::<module> |
| S-02 | 约束 | 传输中新增的输入不能被旧版本确认标为已同步 | src/lib/sync/controller.test.ts::传输等待期间的新输入不能被旧版本确认清除 |
| S-03 | 正常 | 手机文档区独立滚动，连接设置固定在底部，展开后地址及按钮不溢出 | scripts/test-sync-ui.mjs::<module> |
| S-04 | 约束 | 同步复选框复用正文任务的主题参数，明暗和主题切换后视觉一致 | scripts/test-sync-ui.mjs::<module> |
| S-05 | 约束 | 同步面板与普通弹窗一致：打开时启用正文背景模糊，按下面板外空白处关闭整个面板 | - |
| S-06 | 约束 | 底部栏只在存在冲突、待接收文档或可处理的同步失败时出现；已配对但等待对端、传输中或对端未打开时不出现，同步完成后不闪现已同步 | src/lib/sync/controller.test.ts::已配对且确认完成时底栏不呈现同步状态, src/lib/sync/controller.test.ts::对端不可达时不为离线输入固化发送版本, src/lib/sync/controller.test.ts::原生权限拒绝保留可读原因\，不显示对象占位文字 |
