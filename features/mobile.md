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

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 约束 | Android 不调用桌面窗口控制、更新器和系统字体扫描 | src/lib/platform.test.ts::Android 原生环境不具备桌面窗口能力 |
| S-02 | 正常 | 导入文件生成私有副本，编辑不回写来源，导出保留正文 | src/lib/files/android.test.ts::导入系统文档只复制到私有目录\，不回写来源, src/lib/files/android.test.ts::导出使用用户选择的 URI\，取消时不写入 |
| S-03 | 正常 | 触屏可插入任务、缩进、排序及撤销，长按正文保留系统选字 | scripts/test-mobile-browser.mjs::<module> |
| S-04 | 异常 | 应用被终止后可恢复已持久化草稿 | - |
| S-05 | 正常 | 真机长按出现系统选字手柄和复制菜单，菜单显示由截图复核 | scripts/test-android-selection.mjs::<module> |
| S-06 | 约束 | 手机滚动条不占布局空间，全部主题及明暗模式保持相同布局 | scripts/test-sync-ui.mjs::<module> |
| S-07 | 正常 | 手机填写名称后直接创建私有项目，不要求先选择文件位置 | scripts/test-mobile-browser.mjs::<module> |
| S-08 | 正常 | 点击正文底部留白后输入出现在可见段落，隐藏归档保持不变 | src/lib/editor/empty-task-click.test.ts::<module>, scripts/test-mobile-input.mjs::<module>, scripts/test-mobile-native-fixes.mjs::<module> |
| S-09 | 约束 | 删除手机项目清理私有正文和恢复草稿，拒绝删除目录外文件；删除失败保留项目 | src-tauri/src/lib.rs::tests::managed_delete_removes_private_document_and_draft_but_rejects_external_files, src/lib/session/app-integration.test.ts::<module>, scripts/test-mobile-native-fixes.mjs::<module> |
| S-10 | 正常 | 图标辅助栏保持可见，短通知在窄屏保持单行并留出操作空间 | scripts/test-mobile-browser.mjs::<module> |
