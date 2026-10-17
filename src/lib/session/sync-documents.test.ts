import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, FilePort, FileSnapshot } from '../contracts';
import { defaultPreferences } from '../browser-files';
import { SessionSyncDocuments } from './sync-documents';
function fixture() {
  const config: AppConfig = { projects: [{ id: 'local', name: '项目', path: 'a.md' }], activeProjectId: null, preferences: { ...defaultPreferences }, projectViews: {} };
  let disk: FileSnapshot = { path: 'a.md', text: '正文', revision: '1' };
  let draft = false;
  const files = { read: vi.fn(async () => ({ ...disk })), write: vi.fn(async (_: string, text: string, expected: string) => {
    if (disk.revision !== expected) throw new Error('FILE_CONFLICT');
    disk = { ...disk, text, revision: String(Number(expected) + 1) }; return disk;
  }), loadRecovery: async () => draft ? { path: 'a.md', text: '草稿', baseRevision: '1', savedAt: 1 } : null } as unknown as FilePort;
  const options = { files, config: () => config, session: () => undefined, capture() {}, composing: () => false, persist: async () => true, changed() {}, inspiration: async () => 'i.md', receivePath: async () => null };
  return { config, files, options, port: new SessionSyncDocuments(options), external: () => { disk = { ...disk, text: '外部编辑', revision: '2' }; }, draft: () => { draft = true; }, disk: () => disk };
}
describe('同步文档端口', () => {
  it('未打开的项目读取磁盘并同步项目资料', async () => {
    const f = fixture(); const expected = await f.port.read('local');
    await f.port.apply('local', expected, { text: '手机正文', name: '新名称', archived: true });
    expect(f.disk().text).toBe('手机正文'); expect(f.config.projects[0]).toMatchObject({ name: '新名称', archived: true, path: 'a.md' });
  });
  it('外部改动和受保护草稿拒绝远端覆盖', async () => {
    const f = fixture(); const expected = await f.port.read('local'); f.external();
    await expect(f.port.apply('local', expected, { ...expected, text: '远端' })).rejects.toThrow('SYNC_CHANGED');
    expect(f.disk().text).toBe('外部编辑'); f.draft();
    await expect(f.port.read('local')).rejects.toThrow('SYNC_BUSY');
  });
  it('组合输入期间推迟同步且移除关联不删除文件', async () => {
    const f = fixture(); f.options.composing = () => true;
    await expect(f.port.read('local')).rejects.toThrow('SYNC_BUSY');
    f.config.projects = [];
    await expect(f.port.read('local')).rejects.toThrow('SYNC_MISSING');
    expect(f.disk().text).toBe('正文'); expect(f.files.write).not.toHaveBeenCalled();
  });
  it('取消接收不创建项目或文件', async () => {
    const f = fixture(); expect(await f.port.accept(crypto.randomUUID(), 'project', { text: '远端', name: '新项目', archived: false })).toBeNull();
    expect(f.config.projects).toHaveLength(1); expect(f.files.write).not.toHaveBeenCalled();
  });
});
