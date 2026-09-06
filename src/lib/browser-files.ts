/**
 * 文件职责：提供浏览器预览环境的本地沙盒文件适配。
 * 定义范围：浏览器持久化、导入与演示初始文档；桌面环境不使用此适配器。
 */
import type { AppConfig, FilePort, FileSnapshot, RecoveryDraft } from './contracts';

export const defaultPreferences = { theme: 'system' as const, fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif', fontSize: 16, contentWidth: 800 };
export const welcomeText = '# 留一点空间，给接下来要做的事\n\n在这里写下想法，也把它们变成一件件可以完成的小事。\n\n## 今天\n\n- [ ] 整理一个清晰的开始\n\n  直接编辑正文。用 **粗体** 强调重点，用 `代码` 记录细节。\n\n  - [ ] 写下第一步\n  - [x] 为新的想法留出位置\n\n- [ ] 试试折叠一段长笔记\n\n  鼠标移到复选框左边，展开或收起正文。按住复选框拖动可以调整同级任务顺序。\n\n  ```ts\n  const next = "从一件小事开始";\n  ```\n\n- [ ] 留下一条有公式的想法\n\n  把复杂的事情拆开：$E = mc^2$。\n\n## 慢慢来\n\n- [ ] 关联自己的 Markdown 文件\n\n  项目菜单中可以关联已有清单。你的文件仍保留在原来的位置。\n\n- [x] 了解 Foldmark 的归档方式\n\n  完成只改变复选框，正文仍在原位。你可以随时在归档中恢复。\n';

/**
 * 接口职责：实现浏览器沙盒中的 FilePort。
 * 调用方：开发预览与浏览器验收。
 * 实现要求：明确提示浏览器文件是导入副本，不声称已写回本地原文件。
 */
export class BrowserFilePort implements FilePort {
  private key(path: string): string { return `foldmark:file:${path}`; }
  async read(path: string): Promise<FileSnapshot> {
    const value = localStorage.getItem(this.key(path));
    if (value === null) throw new Error('FILE_NOT_FOUND: 文件无法读取，请重新定位');
    return JSON.parse(value) as FileSnapshot;
  }
  async write(path: string, text: string, expectedRevision: string): Promise<FileSnapshot> {
    const previous = await this.read(path);
    if (previous.revision !== expectedRevision) throw new Error('FILE_CONFLICT: 文件已更改');
    const snapshot = { path, text, revision: crypto.randomUUID() };
    localStorage.setItem(this.key(path), JSON.stringify(snapshot)); return snapshot;
  }
  async create(path: string, text: string): Promise<FileSnapshot> {
    if (localStorage.getItem(this.key(path)) !== null) throw new Error('FILE_EXISTS: 文件已存在');
    const snapshot = { path, text: text.replace(/\r\n/g, '\n'), revision: crypto.randomUUID() };
    localStorage.setItem(this.key(path), JSON.stringify(snapshot)); return snapshot;
  }
  async loadConfig(): Promise<AppConfig | null> {
    const value = localStorage.getItem('foldmark:config'); return value ? JSON.parse(value) as AppConfig : null;
  }
  async saveConfig(config: AppConfig): Promise<void> { localStorage.setItem('foldmark:config', JSON.stringify(config)); }
  async loadRecovery(path: string): Promise<RecoveryDraft | null> {
    const value = localStorage.getItem(`foldmark:recovery:${path}`); return value ? JSON.parse(value) as RecoveryDraft : null;
  }
  async saveRecovery(draft: RecoveryDraft): Promise<void> { localStorage.setItem(`foldmark:recovery:${draft.path}`, JSON.stringify(draft)); }
  async clearRecovery(path: string): Promise<void> { localStorage.removeItem(`foldmark:recovery:${path}`); }
  async chooseFile(create: boolean): Promise<string | null> {
    if (create) return `浏览器/清单-${Date.now()}.md`;
    return new Promise(resolve => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.md,.markdown,.txt';
      input.oncancel = () => resolve(null);
      input.onchange = async () => {
        const file = input.files?.[0]; if (!file) { resolve(null); return; }
        const path = `浏览器/${Date.now()}-${file.name}`;
        await this.create(path, await file.text()); resolve(path);
      };
      input.click();
    });
  }
  async watch(path: string, onChange: () => void): Promise<() => void> {
    const handler = (event: StorageEvent) => { if (event.key === this.key(path)) onChange(); };
    window.addEventListener('storage', handler); return () => window.removeEventListener('storage', handler);
  }
}
