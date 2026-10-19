# 移动编辑

## F-MOB-001 Android 离线编辑

手机使用应用私有文件，共用 Markdown 编辑规则，导入副本并允许导出。

创建提交：-

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src/lib/files/android.ts::AndroidFilePort |
| 关键实现 | src/lib/platform.ts::platformCapabilities |
| 关键实现 | src/lib/editor/index.ts::EditorController.mobileCommand |
| 关键实现 | src-tauri/src/lib.rs::delete_managed_document |
| 关键实现 | src/lib/editor/gestures.ts::MarkerGestures |
| 关键实现 | src/lib/editor/paired-symbols.ts::pairedSymbols |
| 关键实现 | src/lib/editor/paired-symbols.ts::singleSymbolPairs |
| 关键实现 | src/lib/editor/paired-symbols.ts::pairingCaret |
| 关键实现 | src/lib/mobile-navigation.ts::registerDrawerGestures |
| 关键实现 | src/App.svelte::dismissPopovers |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 约束 | Android 不调用桌面窗口控制、桌面更新插件和系统字体扫描 | src/lib/platform.test.ts::Android 原生环境不具备桌面窗口能力 |
| S-02 | 正常 | 导入文件生成私有副本，编辑不回写来源，导出保留正文 | src/lib/files/android.test.ts::导入系统文档只复制到私有目录\，不回写来源, src/lib/files/android.test.ts::导出使用用户选择的 URI\，取消时不写入 |
| S-03 | 正常 | 触屏可插入任务、缩进、排序及撤销，长按正文保留系统选字 | scripts/test-mobile-browser.mjs::<module> |
| S-04 | 异常 | 应用被终止后可恢复已持久化草稿 | - |
| S-05 | 正常 | 真机长按出现系统选字手柄和复制菜单，菜单显示由截图复核 | scripts/test-android-selection.mjs::<module> |
| S-06 | 约束 | 手机滚动条不占布局空间，全部主题及明暗模式保持相同布局 | scripts/test-sync-ui.mjs::<module> |
| S-07 | 正常 | 手机填写名称后直接创建私有项目，不要求先选择文件位置 | scripts/test-mobile-browser.mjs::<module> |
| S-08 | 正常 | 点击正文底部留白后输入出现在可见段落，隐藏归档保持不变 | src/lib/editor/empty-task-click.test.ts::<module>, scripts/test-mobile-input.mjs::<module>, scripts/test-mobile-native-fixes.mjs::<module> |
| S-09 | 约束 | 删除手机项目清理私有正文和恢复草稿，拒绝删除目录外文件；删除失败保留项目 | src-tauri/src/lib.rs::tests::managed_delete_removes_private_document_and_draft_but_rejects_external_files, src/lib/session/app-integration.test.ts::<module>, scripts/test-mobile-native-fixes.mjs::<module> |
| S-10 | 正常 | 图标辅助栏保持可见，短通知在窄屏保持单行并留出操作空间 | scripts/test-mobile-browser.mjs::<module> |
| S-11 | 正常 | 菜单、搜索及项目下拉在外部按下时关闭，内部操作保留；手机端关闭浮层的那次按下同时取消默认的焦点转移，浮层关闭与输入法唤起不同时发生；弹窗外触屏关闭后焦点同样不落回正文；手机不显示快捷键弹窗入口 | scripts/test-mobile-navigation.mjs::<module>, scripts/test-mobile-browser.mjs::<module>, src/lib/session/app-integration.test.ts::弹窗外部关闭 |
| S-12 | 正常 | 视口左侧 50% 范围内右滑展开导航，侧栏左滑收起；纵向滚动和右半屏横滑不触发 | scripts/test-mobile-navigation.mjs::<module> |
| S-13 | 正常 | 输入单个开符号（含全角与中文符号）补齐闭符号并把光标放在符号中心；输入法一次提交整对符号，包括组合会话中的提交，同样居中；输入法把编辑器写回的闭符号回发成新输入时保持居中，不把光标推到闭符号之后；英文单词内部的引号不补齐（避免影响撇号），汉字之后照常补齐；在一对符号内部再输入同一个开符号时补齐内层闭符号（`(` 得到 `(())`）；在补齐的闭符号前再输入闭符号会移过去而不是重复插入 | src/lib/editor/bracket-completion.test.ts::成对符号补全, src/lib/editor/bracket-completion.test.ts::手机补齐后输入法把闭符号回发回来时保持居中\，不重复插入, src/lib/editor/paired-symbols.test.ts::输入法成对符号光标居中 |
| S-14 | 正常 | 切换项目或灵感会话后不主动聚焦正文，软键盘只在用户点按正文后出现 | scripts/test-mobile-browser.mjs::<module> |

## F-MOB-002 Android 应用更新

启动时检查并按偏好下载较新的稳定版 APK，校验安装包身份，保存文档后交给 Android 系统确认安装。

创建提交：e6e2b91

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src/lib/updater/android.ts::AndroidUpdatePort |
| 关键实现 | src/lib/updater/update-coordinator.ts::UpdateCoordinator |
| 关键实现 | src-tauri/plugins/mobile/android/src/main/java/AndroidUpdater.kt::AndroidUpdater |
| 关键实现 | src-tauri/plugins/mobile/android/src/main/java/AndroidUpdater.kt::AndroidUpdateRules |
| 关键实现 | scripts/release.mjs::prepareRelease |
| 关键实现 | scripts/release-policy.mjs::verifyReleaseFiles |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 正常 | 只选择当前版本之后带 arm64 APK 的最高稳定版，忽略草稿、预发布和其他仓库资产 | src-tauri/plugins/mobile/android/src/test/java/AndroidUpdateRulesTest.kt::AndroidUpdateRulesTest |
| S-02 | 正常 | 默认自动下载但不自动安装，下载成功和失败均释放监听 | src/lib/updater/android.test.ts::下载成功和失败都移除进度监听\，只有原生校验成功才完成下载, src/lib/updater/update-coordinator.test.ts::默认自动下载并保留累计进度\，但从不自动安装, src/lib/session/app-integration.test.ts::Android 启动检查并自动下载\，安装交接后恢复编辑且隐藏快捷键入口 |
| S-03 | 约束 | 下载包的大小、包名、发布版本、递增版本号和签名须全部校验通过 | - |
| S-04 | 正常 | 未授权安装时打开系统授权页，返回应用后可重试；系统安装器接管后解除编辑锁并保留候选 | src/lib/updater/android.test.ts::未知来源授权不足时保留候选允许重试\，系统安装器接管后应用继续运行, src/lib/updater/update-coordinator.test.ts::系统安装器接管后解除保存锁并保留安装包\，取消安装后可重新发起 |
| S-05 | 异常 | 文档或配置保存失败时不调用系统安装器 | src/lib/updater/update-coordinator.test.ts::保存未成功时保留安装包并禁止原生安装：refused |
| S-06 | 正常 | 没有可安装的新版本时结束检查且不创建候选 | src/lib/updater/android.test.ts::原生没有新版本时不创建下载会话 |

| S-07 | 约束 | v0.7.1 起标签发布必须包含同版本签名 arm64 APK，缺失或摘要不符时禁止公开版本；重跑不覆盖已公开资源 | scripts/release.test.mjs::<module>, scripts/release-policy.test.mjs::<module>, scripts/release-github.test.mjs::<module> |
| S-08 | 异常 | 传输连接中断时重新建立连接并从已写入字节续传；服务端忽略范围请求或资源变化时从头重写 | - |
| S-09 | 异常 | 重试耗尽后界面显示统一的网络中断提示，不暴露平台英文异常 | src/lib/updater/android.test.ts::传输中断的原始英文异常被替换为可重试的网络提示 |
