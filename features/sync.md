# 局域网同步

## F-SYN-001 版本交换与保守合并

同步所选正文和项目资料，使用共同祖先合并独立修改，保留有歧义的双方版本。

创建提交：-

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src/lib/sync/engine.ts::SyncEngine |
| 关键实现 | src/lib/session/sync-documents.ts::SessionSyncDocuments |

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
| S-10 | 正常 | 取消选择撤回对端尚未接收的文档，重启及旧请求重传不能恢复提示，不删除已接收正文 | src/lib/sync/engine.test.ts::同步持久化 > 取消选择撤回尚未接收的文档，重启和旧请求重传不恢复接收提示, src/lib/sync/engine.test.ts::同步持久化 > 取消选择不删除对端已接收的正文和关联, scripts/test-mobile-native-fixes.mjs::<module> |

## F-SYN-002 设备配对与加密连接

一台电脑与一台手机通过短期二维码及电脑确认配对，以认证的加密连接交换文档。

创建提交：-

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src-tauri/src/sync.rs::sync_exchange |
| 关键实现 | src/lib/sync/controller.ts::SyncController |
| 关键实现 | src-tauri/plugins/mobile/android/src/main/java/PairingScannerActivity.kt::PairingScannerActivity |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 正常 | 配对后自动发现电脑并在前台同步，也可手动指定地址 | - |
| S-02 | 异常 | 无效凭证与已撤销设备拒绝交换 | src-tauri/src/sync.rs::tests::revoked_and_unrecognized_devices_cannot_authenticate |
| S-03 | 约束 | 配对信息与本机文件路径不进入普通文档同步数据 | scripts/test-native-lan.mjs::<module> |
| S-04 | 正常 | 配对证书压缩为二维码后字节保持一致，旧输入格式仍可读取 | src/lib/sync/pairing-code.test.ts::二维码压缩证书并保留全部字节\，旧手动格式仍能读取 |
| S-05 | 异常 | 原生权限拒绝显示具体原因，不能显示对象占位文字 | src/lib/sync/controller.test.ts::原生权限拒绝保留可读原因\，不显示对象占位文字 |
| S-06 | 正常 | 扫码界面竖屏取景，关闭和手电筒操作避开系统栏，识别二维码后返回 | - |

## F-SYN-003 同步面板

桌面按区块呈现设备和文档，手机使用整页布局。冲突版本进入独立合并视图，连接设置按需展开。

创建提交：-

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src/lib/SyncPanel.svelte::<module> |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 正常 | 两端正确呈现未配对、已配对、待接收、冲突及失败状态，滚动时关闭入口保持可见 | scripts/test-sync-ui.mjs::<module> |
| S-02 | 约束 | 传输中新增的输入不能被旧版本确认标为已同步 | src/lib/sync/controller.test.ts::传输等待期间的新输入不能被旧版本确认清除 |
| S-03 | 正常 | 手机文档区独立滚动，连接设置固定在底部，展开后地址及按钮不溢出 | scripts/test-sync-ui.mjs::<module> |
| S-04 | 约束 | 同步复选框复用正文任务的主题参数，明暗和主题切换后视觉一致 | scripts/test-sync-ui.mjs::<module> |
