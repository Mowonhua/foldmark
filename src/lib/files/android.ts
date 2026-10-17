/** 手机只编辑托管副本；系统文档 URI 仅在用户导入或导出时访问。 */
import { appDataDir, join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile, mkdir } from '@tauri-apps/plugin-fs';
import { TauriFilePort } from './tauri';
export class AndroidFilePort extends TauriFilePort {
  /** 只删除原生端核验过的私有副本及恢复草稿；不接收导入来源 URI。 */
  async removeOwned(path: string): Promise<void> { await invoke('delete_managed_file', { path }); }
  async managedPath(name = '清单'): Promise<string> {
    const directory = await join(await appDataDir(), 'documents');
    await mkdir(directory, { recursive: true });
    return join(directory, `${name.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 40)}-${crypto.randomUUID()}.md`);
  }
  override async chooseFile(create: boolean): Promise<string | null> {
    if (create) return this.managedPath();
    const uri = await open({ multiple: false, filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }] });
    if (typeof uri !== 'string') return null;
    const text = await readTextFile(uri);
    const path = await this.managedPath('导入');
    await this.create(path, text); return path;
  }
  async exportText(text: string, name: string): Promise<boolean> {
    const extension = name.endsWith('.json') ? 'json' : 'md';
    const uri = await save({ defaultPath: name, filters: [{ name: extension === 'json' ? 'JSON' : 'Markdown', extensions: [extension] }] });
    if (!uri) return false;
    await writeTextFile(uri, text); return true;
  }
  /** 应用私有目录没有外部编辑来源；同步通过保存协调器应用，不依赖文件监听。 */
  override async watch(): Promise<() => void> { return () => {}; }
}
