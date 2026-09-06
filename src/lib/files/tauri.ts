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

/** 使用系统默认程序打开网页或邮件链接；Rust 再次校验协议，文档内容不能请求任意本地程序。 */
export function openExternalLink(url: string): Promise<void> { return command('open_external_link', { url }); }

/**
 * 函数职责：用系统默认应用打开现存本地文档或目录。
 * 输入说明：path 由应用解析 Markdown 相对路径得到。
 * 输出说明：原生边界检查文件类型后打开，拒绝可执行或脚本目标。
 * 实现思路：通过独立平台命令调用，不扩大正文读写端口。
 */
export function openLocalDocument(path: string): Promise<void> { return command('open_local_document', { path }); }

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
    const path = create
      ? await save({ title: '创建 Markdown 清单', defaultPath: '清单.md', filters })
      : await open({ title: '关联 Markdown 清单', multiple: false, directory: false, filters });
    // 对话框路径可能包含目录别名；返回统一绝对路径后，项目层可以可靠判断重复关联。
    return typeof path === 'string' ? command('canonical_file_path', { path, create }) : null;
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
