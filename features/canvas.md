# Markdown 画布

> 模块职责：正文内嵌画布、共享图片附件和含附件的文档搬运。

## F-CAN-001 内嵌自由白板

在 Markdown 中创建独立画布，收起时按本机阅读偏好显示内容预览，展开后在全页编辑文字、图形、连线、手绘和图片。

创建提交：587fdcf

### 功能关系

| 类型 | 功能编号 |
|---|---|
| 依赖 | F-CAN-002 |

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src/lib/editor/index.ts::EditorController.insertCanvas |
| 关键实现 | src/lib/editor/canvas.ts::CanvasEditor |
| 关键实现 | src/lib/editor/canvas.ts::deleteCanvasBlock |
| 关键实现 | src/lib/editor/canvas.ts::moveCanvasBlock |
| 关键实现 | src/lib/editor/gestures.ts::MarkerGestures |
| 关键实现 | src/lib/editor/canvas.ts::canvasEditing |
| 关键实现 | src/lib/editor/canvas.ts::CanvasWidget |
| 关键实现 | src/lib/canvas/model.ts::scanCanvasBlocks |
| 关键实现 | src/lib/canvas/model.ts::serializeCanvasDocument |
| 关键实现 | src/lib/canvas/CanvasPanel.svelte::close |
| 关键实现 | src/lib/canvas/canvas.css::<module> |
| 关键实现 | src/App.svelte::closeCanvas |
| 关键实现 | src/lib/canvas/engine.ts::mountCanvasEngine |
| 关键实现 | src/lib/canvas/save-queue.ts::CanvasSaveQueue |
| 关键实现 | src/lib/canvas/thumbnail.ts::createCanvasThumbnail |
| 关键实现 | src/App.svelte::pageText |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 正常 | 在标题、正文或列表容器后插入画布并直接打开；新画布和后续编辑进入当前文档的撤销历史 | src/lib/editor/canvas.test.ts::插入画布后即时打开\，卡片在光标内保持折叠\，源码显示完整文本\，插入一次撤销, src/lib/editor/canvas.test.ts::列表内插入保留容器\，归档可打开只读会话\，坏格式保持原文, src/lib/editor/canvas.test.ts::默认标题开头的光标可在标题后插入画布\，保留原标题与后续正文 |
| S-02 | 约束 | 收起卡片以内容预览为主，标题弱化在左下角，右上按钮展开为全页；紧凑、适中、宽松分别占正文两行、六行、十二行；收起后恢复原阅读位置 | - |
| S-03 | 正常 | 本机编辑即时显示；拖动中的中间帧不提交正文，结束交互后只提交最终场景 | src/lib/canvas/save-queue.test.ts::拖动时不提交中间帧\，松手后只提交最终场景 |
| S-04 | 约束 | 快照以完整 JSON 保存，不包含工具、选区或阅读位置；历史多行 JSON 首次修改后保存为一行，源码模式保留可编辑原文 | src/lib/canvas/model.test.ts::空画布独立分配身份\，整个快照保留引擎字段并序列化为单行, src/lib/editor/canvas.test.ts::多行快照第一次保存归并成一行\，连续提交和关闭仍保留图片恢复引用, src/lib/editor/canvas.test.ts::画布不属于可编辑代码块\，源码模式保留原生文本编辑 |
| S-05 | 异常 | 损坏或不支持的画布格式保持原文，不降级打开或写回 | src/lib/canvas/model.test.ts::画布持久化格式, src/lib/editor/canvas.test.ts::列表内插入保留容器\，归档可打开只读会话\，坏格式保持原文 |
| S-06 | 并发 | 同文档复制出相同画布 ID 时，只更新打开的源文范围；范围前的编辑不改变提交目标 | src/lib/editor/canvas.test.ts::同 ID 的两个块只更新被打开的范围\，块前插入文字后仍命中原块 |
| S-07 | 异常 | 外部改写、删除、整块替换或切换文档后拒绝旧会话提交；即使正文相同或撤销恢复也不复活旧会话 | src/lib/editor/canvas.test.ts::外部改写或删除后拒绝旧提交\，即使撤销回来也不能复活旧会话, src/lib/editor/canvas.test.ts::相同正文切换文档仍使会话失效\，旧 close 不干扰新文档, src/lib/editor/canvas.test.ts::删除原块后在同处粘贴相同快照\，也不把旧会话移交给新块 |
| S-08 | 约束 | 归档画布可展开查看，禁止提交编辑 | src/lib/editor/canvas.test.ts::列表内插入保留容器\，归档可打开只读会话\，坏格式保持原文 |
| S-09 | 异常 | 保存队列失败后保留待提交场景并允许重试，不显示已保存 | src/lib/canvas/save-queue.test.ts::附件写入失败不提交正文\，重试保留同一场景, src/lib/canvas/save-queue.test.ts::源块失效时拒绝提交\，不能误报已保存 |
| S-10 | 约束 | 收起时不加载完整白板引擎；展开后才加载渲染引擎和同源字体，浅深色切换不修改图形颜色 | - |
| S-11 | 正常 | 导出当前画布为 PNG；导出使用白色背景，最长边不超过 4096 像素，不携带可编辑场景 | - |
| S-12 | 边界 | 引擎默认字段含 undefined 时，保存队列仍可提交，JSON 省略 undefined 并保留图形 | src/lib/editor/canvas.test.ts::保存队列传入引擎的 undefined 默认字段时\，真实会话仍能提交并保留图形 |
| S-13 | 异常 | 关闭前等待画布队列及文档保存；保存失败保留全页编辑现场，不关闭画布；收起后立即发起同步交换，补发编辑期间暂缓的文档 | src/lib/session/app-integration.test.ts::收起画布等待正文落盘时锁住引擎\，保存失败恢复编辑且重试保留最新图形, src/lib/session/app-integration.test.ts::桌面关闭等待画布正文落盘时锁住引擎\，保存失败恢复编辑且成功后才销毁窗口 |
| S-14 | 边界 | 待办文末导航将光标放入隐藏归档后，插入画布仍落在待办末尾、归档标题之前，保存与关闭后卡片保持可见 | src/lib/editor/canvas.test.ts::待办的 todo 隐藏归档光标插入画布时落在归档标题前, src/lib/session/app-integration.test.ts::待办 Ctrl+End 落到隐藏归档后插入画布\，关闭和保存后卡片仍在待办可见区域 |
| S-15 | 正常 | 真实应用中插入、提交、关闭及重启保留画布和正文 | src/lib/session/app-integration.test.ts::首次无配置欢迎文档插入画布后\，自动保存与关闭不能恢复初始欢迎正文, src/lib/session/app-integration.test.ts::插入画布后提交图形与标题\，关闭、外部检查及重启都保留同一份正文 |
| S-16 | 正常 | 设置中的画布预览三档即时生效并持久化，旧配置默认紧凑；重启和源码切换不改变正文 | src/lib/session/app-integration.test.ts::画布预览三档即时应用并持久化\，重启与源码切换不修改正文, src/lib/config-validation.test.ts::画布预览档位兼容旧配置并拒绝非法值 |
| S-17 | 约束 | 预览呈现文字和真实连线路径；重复图片去重读取，卸载释放资源，过期异步读取不创建图片 URL | src/lib/canvas/thumbnail.test.ts::呈现真实文字与线条路径\，忽略已删除内容\，转义不可信文字, src/lib/canvas/thumbnail.test.ts::重复图片只读取一次\，卸载释放 URL\，读取完成前卸载不创建 URL |
| S-18 | 正常 | 更多操作与右键插入菜单共用画布插入命令，插入后直接打开，一次撤销恢复原文 | src/lib/editor/canvas.test.ts::右键插入菜单复用画布命令并直接打开\，一次撤销恢复原文 |
| S-19 | 正常 | 右键画布复用菜单里的删除命令整块移除，不新增专用项；画布后按 Backspace 或手机删除键、画布前按 Delete 都整块移除画布并整理段落分隔，一次撤销恢复原文；画布与相邻段落之间隔着空行时删除键只合并空行；卡片与下一段之间不留空行，光标不能停进闭围栏 | src/lib/editor/canvas.test.ts::画布后的 Backspace 整块删除\，一次撤销恢复原文, src/lib/editor/canvas.test.ts::画布前的 Delete 整块删除并保留前后段落, src/lib/editor/canvas.test.ts::画布与相邻段落之间隔着空行时\，删除键只合并空行而不删画布, src/lib/editor/canvas.test.ts::右键画布复用菜单里的删除项整块移除\，不新增专用项, src/lib/editor/canvas.test.ts::画布卡片不与下一段之间残留空行\，光标不能停进闭围栏 |
| S-20 | 正常 | 按住画布卡片拖动与按住任务复选框拖动一致：显示标题预览和插入线，靠近编辑区边缘自动滚动，松手整块移动并按落点行首缩进；末尾落点停在隐藏归档之前；拖出编辑区、按 Esc 或归档只读时取消，一次撤销恢复原顺序 | src/lib/editor/canvas.test.ts::按住画布拖到可见内容末尾整块移动\，预览与插入线跟随并一次撤销, src/lib/editor/canvas.test.ts::画布拖入列表容器时按落点行首缩进\，一次撤销恢复原位置, src/lib/editor/canvas.test.ts::画布移到顶层缩进代码块前保持围栏不被当作代码缩进, src/lib/editor/canvas.test.ts::画布拖到待办末尾时停在隐藏归档之前\，不改写归档正文, src/lib/editor/canvas.test.ts::画布拖出编辑区或按 Esc 取消\，归档画布不能拖动 |
| S-21 | 约束 | 手机展开全页画布时，标题栏位于系统状态栏下方，画布编辑区不进入系统导航栏 | scripts/test-mobile-browser.mjs::<module> |
| S-22 | 约束 | 画布快照不计入状态栏当前页字数，收起与源码视图的统计一致 | src/lib/session/app-integration.test.ts::画布快照不计入当前页字数\，预览与源码一致 |

## F-CAN-002 共享图片附件

画布接收 PNG、JPEG 和 WebP 图片，以内容摘要命名，保存在 Markdown 同目录的共享 `.assets/` 中。

创建提交：587fdcf

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src/lib/canvas/assets.ts::createCanvasAssetPort |
| 关键实现 | src/lib/canvas/assets.ts::validateCanvasImage |
| 关键实现 | src/lib/canvas/assets.ts::verifyCanvasAssetBytes |
| 关键实现 | src/lib/canvas/model.ts::canvasAssetsFromText |
| 关键实现 | src/lib/canvas/save-queue.ts::CanvasSaveQueue |
| 关键实现 | src-tauri/src/canvas_assets.rs::put |
| 关键实现 | src-tauri/src/canvas_assets.rs::read |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 正常 | 同目录文档共享内容相同的图片；重命名 Markdown 不改变相对引用，重复或并发导入不覆盖已有附件 | src/lib/canvas/assets.test.ts::同目录文档和新端口复用已持久化图片\，重命名文档不改变引用, src/lib/canvas/assets.test.ts::并发导入同一图片复用首次写入记录\，Windows 路径按目录共享 |
| S-02 | 约束 | 仅接收单张不超过 20 MiB 的 PNG、JPEG 和 WebP，拒绝路径逃逸、格式伪装和损坏图片 | src/lib/canvas/assets.test.ts::拒绝路径逃逸、格式伪装与超大图片\，读取损坏附件时报告错误, src/lib/canvas/model.test.ts::附件路径必须被摘要约束\，序列化拒绝非法持久化数据, src/lib/canvas/save-queue.test.ts::超大内嵌图片在 Base64 解码之前被拒绝 |
| S-03 | 约束 | 图片完整保存后才向正文提交相对引用；Markdown 不保存图片 data URL，附件失败时保持旧正文 | src/lib/canvas/save-queue.test.ts::先保存图片再提交引用\，Markdown 不含 data URL, src/lib/canvas/save-queue.test.ts::附件写入失败不提交正文\，重试保留同一场景, src/lib/canvas/save-queue.test.ts::相同 fileId 的图片字节改变时重新保存\，不误用旧摘要 |
| S-04 | 并发 | 保存图片期间的新编辑按顺序继续提交，已经保存的图片不重复写入 | src/lib/canvas/save-queue.test.ts::保存期间的新变化仍按顺序提交\，复用已保存图片 |
| S-05 | 约束 | 正文提交保留图片恢复引用，连续提交和撤销不丢失图片路径 | src/lib/editor/canvas.test.ts::多行快照第一次保存归并成一行\，连续提交和关闭仍保留图片恢复引用 |
| S-06 | 正常 | 浏览器预览在 IndexedDB 保存图片，原生应用在同目录 `.assets/` 保存图片；浏览器图片不占用 localStorage | src/lib/canvas/assets.test.ts::同目录文档和新端口复用已持久化图片\，重命名文档不改变引用, src-tauri/src/canvas_assets.rs::tests::repeated_import_shares_directory_and_preserves_bytes_and_creation |
| S-07 | 正常 | 通过白板图片工具、粘贴或拖入插入图片，图片对象可移动、缩放和旋转 | - |
| S-08 | 约束 | 删除图形或画布不自动删除共享附件 | - |

## F-CAN-003 完整文档搬运

将 Markdown 和正文实际引用的画布附件导出为 ZIP，导入时先验证并保存附件，再创建文档。

创建提交：587fdcf

### 功能关系

| 类型 | 功能编号 |
|---|---|
| 依赖 | F-CAN-002 |

### 实现

| 角色 | 代码符号 |
|---|---|
| 主入口 | src/App.svelte::exportCanvasBundle |
| 主入口 | src/App.svelte::importCanvasBundle |
| 关键实现 | src/lib/canvas/bundle.ts::exportBundle |
| 关键实现 | src/lib/canvas/bundle.ts::importBundle |

### 行为场景

| 编号 | 类型 | 场景与预期 | 测试 |
|---|---|---|---|
| S-01 | 正常 | ZIP 包含 Markdown、格式清单和实际引用的图片；导入新目录后正文与图片保持一致 | src/lib/canvas/bundle.test.ts::完整往返只携带引用附件\，先落盘后提供正文 |
| S-02 | 约束 | 导入前验证路径、条目、包大小、引用及图片摘要；任一校验或附件写入失败都不返回可创建的正文 | - |
| S-03 | 边界 | 完整包及解压后总量不超过 128 MiB，Markdown 不超过 8 MiB，图片不超过 1024 张 | - |
| S-04 | 正常 | 导入完整文档创建独立项目；只导出 Markdown 时保留画布 JSON，图片仍由原附件目录保存 | - |
| S-05 | 约束 | 导出时不携带正文未引用的附件 | - |
