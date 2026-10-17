<p align="center">
  <img src="./src-tauri/icons/icon.png" width="64" height="64" alt="Foldmark 标志">
</p>

<h1 align="center">Foldmark</h1>

<p align="center">多项目 Markdown 待办编辑器：一个项目就是一份普通 <code>.md</code> 文件。</p>

<p align="center">Windows x64 · Android · 本地文件 · MIT</p>

<p align="center">
  <a href="https://github.com/Mowonhua/foldmark/releases">下载</a> ·
  <a href="./docs/使用.md">使用指南</a> ·
  <a href="./docs/主题.md">自制主题</a> ·
  <a href="https://github.com/Mowonhua/foldmark/issues">反馈问题</a>
</p>

<p align="center">
  <img src="./assets/readme/workspace.png" width="100%" alt="Foldmark 编辑界面：左侧切换项目，右侧在 Markdown 原文中编辑正文、嵌套任务与代码块。截图使用演示数据。">
</p>

## 主要功能

- **一个项目就是一份文件**：关联已有 `.md` 文件即可开始编辑。正文保留在原位，其他编辑器可以继续打开，移除项目只移除关联。
- **任务和上下文放在一起**：支持嵌套任务、代码高亮、KaTeX 公式和图片。拖动列表标记可调整同级顺序。
- **完成的任务整组归档**：父任务及全部子任务完成后，完整子树移到文件末尾的 `# 归档` 区域。点击复选框把整组恢复到原章节。
- **跨项目找到下一步**：“全部待办”汇总各项目的任务，搜索结果可直接定位到原文。
- **章节目录随手切换**：侧边栏可切换为当前文档的大纲。点击章节直达原文，滚动时当前章节高亮跟随。
- **灵感有独立位置**：侧栏“灵感”托管一份独立 Markdown 文件，记录项目之外的想法，成熟后可搬进项目。
- **阅读方式可选**：预览与分区源码视图可切换。内置纸面、纯粹双色、新拟物、液态玻璃、磨砂玻璃五套主题，各有浅色和深色，可跟随系统，也可导入自制 JSON 主题。

输入后自动保存。外部修改、文件冲突或保存失败时，应用保留未保存的内容并提供恢复入口。详见[保存与恢复规则](./docs/使用.md#保存外部编辑与恢复)。

Android 版共用编辑与任务规则，使用手机内的 Markdown 副本。电脑与手机可在同一局域网内配对，同步选定项目和灵感簿。使用方式与构建说明见[手机版与同步](./docs/手机版与同步.md)。

<details>
<summary>任务文件仍然是普通 Markdown</summary>

````markdown
# 工作手记

- [ ] 整理产品笔记

  把 **关键决定** 和待确认事项放在一起。

  - [ ] 梳理反馈
  - [ ] 写下下一步

# 归档

- [x] 建立项目清单
````

</details>

## 开始使用

1. 从 [GitHub Releases](https://github.com/Mowonhua/foldmark/releases) 下载 Windows x64 的 `-setup.exe` 并安装。Foldmark 运行需要 WebView2；设备缺少 WebView2 时，安装程序会联网下载。
2. 打开 Foldmark，点击“新增项目”，关联一份已有 Markdown 文件或新建清单。
3. 输入 `- [ ]` 创建任务。按 `Enter` 创建下一项；在空任务上再按一次 `Enter` 退出列表。

应用默认在启动时检查更新并自动下载。从“更多操作 → 检查更新”可打开更新面板。点击“安装并重启”后，全部文档和配置保存成功才会开始安装。详见[自动更新与发布流程](./docs/发布.md)。

## 本地开发

Foldmark 使用 Tauri 2 · Svelte 5 · TypeScript · CodeMirror 6。Windows 开发需要 Node.js、npm、Rust 和 MSVC C++ 构建工具。

```powershell
npm ci
npm run tauri -- dev
```

只预览前端可运行 `npm run dev`。浏览器预览导入的是文件副本；关联原文件和系统文件监听需要桌面版。

<p>
  <a href="https://github.com/Mowonhua/foldmark/actions/workflows/ci.yml"><img src="https://github.com/Mowonhua/foldmark/actions/workflows/ci.yml/badge.svg?branch=main" alt="Windows CI 状态"></a>
</p>

[构建、测试与性能采样](./docs/开发.md) · [产品与技术方案](./docs/方案.md)

## 许可证

[MIT License](./LICENSE) · Copyright © 2026 Mowonhua
