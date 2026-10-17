import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn(), read: vi.fn(), write: vi.fn(), open: vi.fn(), save: vi.fn(), mkdir: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: async () => '/private/foldmark', join: async (...parts: string[]) => parts.join('/') }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: native.open, save: native.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: native.read, writeTextFile: native.write, mkdir: native.mkdir }));
import { AndroidFilePort } from './android';
beforeEach(() => { vi.resetAllMocks(); });
it('导入系统文档只复制到私有目录，不回写来源', async () => {
  native.open.mockResolvedValue('content://provider/note'); native.read.mockResolvedValue('# 原文');
  const files = new AndroidFilePort(); const path = await files.chooseFile(false);
  expect(path).toMatch(/^\/private\/foldmark\/documents\/导入-.*\.md$/);
  expect(native.invoke).toHaveBeenCalledWith('create_file', { path, text: '# 原文' });
  expect(native.write).not.toHaveBeenCalled();
});
it('导出使用用户选择的 URI，取消时不写入', async () => {
  const files = new AndroidFilePort(); native.save.mockResolvedValue(null);
  expect(await files.exportText('正文', '清单.md')).toBe(false); expect(native.write).not.toHaveBeenCalled();
  native.save.mockResolvedValue('content://provider/export');
  expect(await files.exportText('正文', '清单.md')).toBe(true);
  expect(native.write).toHaveBeenCalledWith('content://provider/export', '正文');
});
it('手机删除项目交给私有文件删除命令，不写回导入来源', async () => {
  const files = new AndroidFilePort(); await files.removeOwned('/private/foldmark/documents/project.md');
  expect(native.invoke).toHaveBeenCalledWith('delete_managed_file', { path: '/private/foldmark/documents/project.md' });
  expect(native.write).not.toHaveBeenCalled();
});
