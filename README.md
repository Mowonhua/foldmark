# Foldmark

面向 Windows 的多项目 Markdown 待办编辑器。连续输入正文、公式和嵌套任务，完成后在待办视图收起，随时从归档恢复。

正文保存在你关联的 Markdown 原文件中。勾选只修改 `[ ]` / `[x]`，任务及其正文留在原位置；移除项目只移除关联。

## 使用

打开应用后，选择“新增项目”，关联已有 `.md` 文件或在指定位置新建清单。

- **待办**：就地编辑 Markdown。列表圆点、编号和任务复选框可拖动同级排序；左侧三角折叠正文和后代。
- **归档**：查阅已完成任务，点击复选框恢复。父任务存在未完成后代时，使用“完成整组”明确完成所有子项。
- **完整源码**：编辑全部原文，包括已完成任务及暂未渲染的语法。
- **全部待办与搜索**：跨项目查找任务，点击结果回到原文。搜索可包含归档，并会展开目标所在的折叠祖先。
- **阅读与外观**：浅色、深色、跟随系统，以及可配置字体、字号和正文宽度。

| 操作 | 快捷键 |
| --- | --- |
| 创建下一个任务 / 空任务退出列表 | `Enter` |
| 在任务首行内插入正文换行 | `Shift + Enter` |
| 整项缩进 / 反缩进 | `Tab` / `Shift + Tab` |
| 当前项目撤销 / 重做 | `Ctrl + Z` / `Ctrl + Shift + Z` |
| 手动保存 | `Ctrl + S` |
| 快速查找项目 | `Ctrl + P` |
| 跨项目搜索 | `Ctrl + Shift + F` |
| 聚焦列表标记后同级排序 | `Alt + ↑` / `Alt + ↓` |
| 打开预览中的链接 | `Ctrl + 单击` |

代码块、公式块和正文中的 Enter 保留正常换行语义。公式采用 KaTeX 数学语法；错误或未闭合公式保留原文并显示局部提示。

## 保存、外部编辑与恢复

输入后自动保存，也可以手动保存。每个文档的保存请求按顺序处理，写入前检查磁盘内容指纹，使用同目录临时文件原子替换；保留 UTF-8 BOM、CRLF 及未修改行的混合换行。

其他应用修改文件时，无本地修改的文档自动加载新内容。有未保存修改时展示双方文本，可手动合并、另存副本或明确选择版本。保存失败会保留内存正文并显示错误，可重试或重新定位文件。

恢复草稿与项目配置位于系统应用数据目录下的 `app.foldmark.desktop`。应用启动发现不同于磁盘的草稿时，会显示恢复入口；“暂不恢复”不会删除草稿。损坏的恢复数据先保留独立备份，界面说明备份位置，Markdown 原文件仍可查看。关闭桌面窗口前会等待正文与配置保存；保存失败时保留窗口供处理。

## 开发与构建

需要 Node.js、npm、Rust，以及 Windows 的 MSVC C++ 构建工具。桌面运行需要 WebView2。

```powershell
npm ci
npm run tauri -- dev
```

只预览前端：

```powershell
npm run dev
```

浏览器预览使用独立的浏览器存储，导入的是文件副本，可通过菜单另存 Markdown；实际原文件关联和系统文件监听需要桌面应用。

构建 Windows NSIS 安装包：

```powershell
npm run tauri -- build
```

默认输出为 `src-tauri/target/release/bundle/nsis/Foldmark_0.1.0_x64-setup.exe`。安装包采用 WebView2 下载引导方式；机器缺少运行时时，首次安装需要联网下载。需要离线安装的设备应预先安装 Microsoft WebView2 Evergreen Runtime。应用正文、搜索、公式和保存均在本地工作。

## 验证

```powershell
npm run check
npm test
npm run test:app
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run build
```

`test:app` 使用真实 Svelte App、CodeMirror 和文件适配器，覆盖输入落盘、重启、项目切换、撤销隔离、搜索和失败边界。Rust 测试在真实临时目录验证原子保存、文件冲突、编码换行和监听。

性能采样与功能验收分别记录。内核与同步编辑事务耗时不能替代屏幕反馈、原生冷启动或整个 WebView 进程组的内存数据。

- [产品与技术方案](docs/方案.md)
- [内核基准原始记录](docs/performance-core.json)
- [原生验证与进程内存记录](docs/native-validation.json)
- [首版验收检查](docs/验收检查.md)
- [真实浏览器输入与勾选采样](docs/performance-browser.json)
- [浏览器交互与布局检查](docs/browser-validation.json)
- [Windows 安装与卸载验证](docs/installer-validation.json)

内核基准：`npm run benchmark:core`。编辑器同步事务基准：`npx vitest run --config src/lib/editor/vitest.perf.config.ts`。

浏览器交互基准使用独立生产构建，避免开发热更新中断采样：

```powershell
npm run benchmark:browser:build
npm run benchmark:browser
```

打开 [浏览器验收页](http://127.0.0.1:1421/tests/browser-performance.html)，载入固定场景后逐次输入或完成 20 项，再导出 JSON 报告。输入至下一 rAF 的计时用于定位性能问题，不等同于屏幕像素最终呈现时间。
