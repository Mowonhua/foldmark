/**
 * 文件职责：将应用文件端口适配到 Tauri 桌面命令。
 * 定义范围：平台调用、文件选择、外部变更订阅和稳定错误转换。
 */
import type { AppConfig, FilePort, FileSnapshot, RecoveryDraft } from '../contracts';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';

/** Rust 的结构化错误转为 Error，同时保留 code 供保存策略区分冲突、路径失效和权限问题。 */
async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(name, args); }
  catch (cause: unknown) {
    const detail = typeof cause === 'object' && cause !== null ? cause as { code?: string; message?: string } : {};
    throw Object.assign(new Error(detail.message ?? String(cause)), { code: detail.code ?? 'FILE_IO' });
  }
}

/**
 * 接口职责：提供异步桌面文件访问能力。
 * 调用方：应用保存协调器与项目会话。
 * 实现要求：正文快照统一 LF，revision 覆盖原始字节，BOM 与 CRLF 由 Rust 保留。
 */
export class TauriFilePort implements FilePort {
  read(path: string): Promise<FileSnapshot> { return command('read_file', { path }); }
  write(path: string, text: string, expectedRevision: string): Promise<FileSnapshot> { return command('write_file', { path, text, expectedRevision }); }
  create(path: string, text: string): Promise<FileSnapshot> { return command('create_file', { path, text }); }
  loadConfig(): Promise<AppConfig | null> { return command('load_config'); }
  saveConfig(config: AppConfig): Promise<void> { return command('save_config', { config }); }
  loadRecovery(path: string): Promise<RecoveryDraft | null> { return command('load_recovery', { path }); }
  saveRecovery(draft: RecoveryDraft): Promise<void> { return command('save_recovery', { draft }); }
  clearRecovery(path: string): Promise<void> { return command('clear_recovery', { path }); }
  async chooseFile(create: boolean): Promise<string | null> {
    const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }];
    if (create) return save({ title: '创建 Markdown 清单', defaultPath: '清单.md', filters });
    const path = await open({ title: '关联 Markdown 清单', multiple: false, directory: false, filters });
    return typeof path === 'string' ? path : null;
  }
  async watch(path: string, onChange: () => void): Promise<() => void> {
    let watchId: number | undefined;
    const unlisten = await listen<number>('foldmark:file-change', event => {
      if (event.payload === watchId) onChange();
    });
    try { watchId = await command<number>('watch_file', { path }); }
    catch (error) { unlisten(); throw error; }
    return () => { unlisten(); void command('unwatch_file', { watchId }).catch(() => undefined); };
  }
}
