import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalePreference } from '../i18n';
import { TauriFilePort } from './tauri';

const native = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: native.open, save: native.save }));

beforeEach(() => { vi.resetAllMocks(); setLocalePreference('en'); });
afterEach(() => { setLocalePreference('zh-CN'); });

describe('桌面文件语言边界', () => {
  it('每次操作使用当前语言且保留冲突错误代码', async () => {
    const port = new TauriFilePort();
    native.invoke.mockRejectedValue({ code: 'FILE_CONFLICT', message: '磁盘文件已变化，保留未保存内容。' });
    await expect(port.write('任务.md', '正文', 'old')).rejects.toMatchObject({
      code: 'FILE_CONFLICT', message: 'The file on disk has changed. Unsaved content has been retained.',
    });
    setLocalePreference('zh-CN');
    await expect(port.write('任务.md', '正文', 'old')).rejects.toMatchObject({
      code: 'FILE_CONFLICT', message: '磁盘文件已变化，保留未保存内容。',
    });
    expect(native.invoke).toHaveBeenLastCalledWith('write_file', { path: '任务.md', text: '正文', expectedRevision: 'old' });
  });

  it('翻译损坏草稿提示并原样保留备份路径和底层诊断', async () => {
    const path = 'D:\\项目\\{reason}\\恢复.json';
    native.invoke.mockRejectedValue({ code: 'RECOVERY_INVALID', message: `恢复草稿不是有效 JSON：unexpected token 原始数据已完整保留在备份：${path}。` });
    await expect(new TauriFilePort().loadRecovery('任务.md')).rejects.toMatchObject({
      code: 'RECOVERY_INVALID', message: `The recovery draft is not valid JSON: unexpected token The original data has been preserved in a backup: ${path}.`,
    });
  });

  it('本地化创建对话框并继续使用原生规范路径', async () => {
    native.save.mockResolvedValue('D:\\清单.md');
    native.invoke.mockResolvedValue('D:/清单.md');
    expect(await new TauriFilePort().chooseFile(true)).toBe('D:/清单.md');
    expect(native.save).toHaveBeenCalledWith(expect.objectContaining({ title: 'Create Markdown list', defaultPath: 'List.md' }));
    expect(native.invoke).toHaveBeenCalledWith('canonical_file_path', { path: 'D:\\清单.md', create: true });
  });
});
