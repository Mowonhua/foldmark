/** 文件职责：验证自动保存的顺序、外部冲突及恢复保留契约。 */
import { describe, expect, it, vi } from 'vitest';
import type { FilePort, FileSnapshot } from '../contracts';
import { SaveCoordinator, type SaveOptions } from './save-coordinator';

function fixture(preserveRecovery = false) {
  let disk: FileSnapshot = { path: 'a.md', text: 'base', revision: '1' };
  let text = 'base';
  const status = vi.fn();
  const files = {
    read: vi.fn(async () => disk),
    write: vi.fn(async (_path: string, next: string, revision: string) => {
      if (revision !== disk.revision) throw new Error('FILE_CONFLICT');
      disk = { ...disk, text: next, revision: String(Number(disk.revision) + 1) };
      return disk;
    }),
    saveRecovery: vi.fn(async () => {}), clearRecovery: vi.fn(async () => {}),
  } as unknown as FilePort;
  const reload = vi.fn<SaveOptions['reload']>(value => { text = value; });
  const saver = new SaveCoordinator({ files, snapshot: disk, getText: () => text, reload, onStatus: status, delay: 60000, preserveRecovery });
  return { saver, files, status, reload, setText: (value: string) => { text = value; saver.changed(); }, getText: () => text, external: (value: string) => { disk = { ...disk, text: value, revision: '9' }; }, disk: () => disk };
}

describe('单文档保存协调', () => {
  it('暂不恢复已有草稿时，无编辑保存不会删除该草稿', async () => {
    const f = fixture(true);
    expect(await f.saver.flush()).toBe(true);
    expect(f.files.clearRecovery).not.toHaveBeenCalled(); f.saver.dispose();
  });
  it('选用磁盘版本后，正常关闭仍保留被替换的本地恢复稿', async () => {
    const f = fixture(); f.setText('local draft'); f.external('disk version');
    await f.saver.acceptExternal(f.disk());
    expect(f.reload).toHaveBeenCalledWith('disk version', 'accepted');
    expect(await f.saver.flush()).toBe(true);
    expect(f.files.saveRecovery).toHaveBeenCalledWith(expect.objectContaining({ text: 'local draft' }));
    expect(f.files.clearRecovery).not.toHaveBeenCalled(); f.saver.dispose();
  });
  it('已有草稿被明确恢复并成功写回后可清理恢复文件', async () => {
    const f = fixture(true); f.setText('restored content');
    expect(await f.saver.flush()).toBe(true);
    expect(f.files.clearRecovery).toHaveBeenCalled(); f.saver.dispose();
  });
  it('合并连续输入并只保存最新快照', async () => {
    const f = fixture(); f.setText('one'); f.setText('two');
    expect(await f.saver.flush()).toBe(true);
    expect(f.disk().text).toBe('two');
    expect(f.files.write).toHaveBeenCalledTimes(1);
    expect(f.files.clearRecovery).toHaveBeenCalled(); f.saver.dispose();
  });
  it('存在本地修改时保留双方并拒绝覆盖外部版本', async () => {
    const f = fixture(); f.setText('mine'); f.external('theirs');
    expect(await f.saver.flush()).toBe(false);
    expect(f.disk().text).toBe('theirs'); expect(f.getText()).toBe('mine');
    expect(f.status).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'conflict' }));
    expect(f.files.clearRecovery).not.toHaveBeenCalled(); f.saver.dispose();
  });
  it('无本地修改时自动载入外部文本', async () => {
    const f = fixture(); f.external('outside'); await f.saver.checkExternal();
    expect(f.getText()).toBe('outside');
    expect(f.reload).toHaveBeenCalledWith('outside', 'external');
    expect(f.status).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'saved' }));
    f.saver.dispose();
  });
  it('自动载入回调整理了正文时保持未保存状态，并以外部版本为基线写回', async () => {
    const f = fixture();
    f.reload.mockImplementation((value, reason) => {
      expect(reason).toBe('external');
      f.setText(`${value}\n\n# 归档\n`);
    });
    try {
      f.external('outside'); await f.saver.checkExternal();
      expect(f.getText()).toBe('outside\n\n# 归档\n');
      expect(f.saver.hasLocalChanges).toBe(true);
      expect(f.status).toHaveBeenLastCalledWith({ kind: 'dirty', message: '未保存' });
      expect(f.files.write).not.toHaveBeenCalled();
      expect(await f.saver.flush()).toBe(true);
      expect(f.files.write).toHaveBeenCalledWith('a.md', 'outside\n\n# 归档\n', '9');
      expect(f.saver.hasLocalChanges).toBe(false);
    } finally { f.saver.dispose(); }
  });
  it('保存过程中输入的更新在同一次 flush 中顺序落盘', async () => {
    const f = fixture(); const original = f.files.write;
    let first = true;
    f.files.write = vi.fn(async (path: string, text: string, revision: string) => {
      if (first) { first = false; f.setText('newest'); }
      return original(path, text, revision);
    });
    f.setText('first'); expect(await f.saver.flush()).toBe(true);
    expect(f.disk().text).toBe('newest'); expect(f.files.write).toHaveBeenCalledTimes(2); f.saver.dispose();
  });
  it('磁盘写入失败时恢复快照仍保留', async () => {
    const f = fixture(); f.files.write = vi.fn(async () => { throw new Error('FILE_WRITE: locked'); });
    f.setText('draft'); expect(await f.saver.flush()).toBe(false);
    expect(f.files.saveRecovery).toHaveBeenCalledWith(expect.objectContaining({ text: 'draft' }));
    expect(f.files.clearRecovery).not.toHaveBeenCalled(); f.saver.dispose();
  });
});

describe('异步外部读取与保存基线', () => {
  it('保存期间挂起的旧读取不得回退刚保存的正文', async () => {
    const f = fixture();
    let releaseRead!: (snapshot: FileSnapshot) => void;
    const oldSnapshot = f.disk();
    f.files.read = vi.fn(() => new Promise<FileSnapshot>(resolve => { releaseRead = resolve; }));
    const checking = f.saver.checkExternal();
    f.setText('just saved'); expect(await f.saver.flush()).toBe(true);
    releaseRead(oldSnapshot); await checking;
    expect(f.getText()).toBe('just saved'); expect(f.disk().text).toBe('just saved');
    f.saver.dispose();
  });
  it('较早发起的外部读取不得覆盖较晚读取确认的版本', async () => {
    const f = fixture();
    const releases: ((snapshot: FileSnapshot) => void)[] = [];
    f.files.read = vi.fn(() => new Promise<FileSnapshot>(resolve => { releases.push(resolve); }));
    const first = f.saver.checkExternal();
    const second = f.saver.checkExternal();
    releases[1]({ path: 'a.md', text: 'newer outside', revision: '3' }); await second;
    releases[0]({ path: 'a.md', text: 'older outside', revision: '2' }); await first;
    expect(f.getText()).toBe('newer outside'); f.saver.dispose();
  });
  it('用户选择本地版本后磁盘再变更仍保留双方并拒绝覆盖', async () => {
    const f = fixture(); f.setText('local'); f.external('outside');
    expect(await f.saver.flush()).toBe(false);
    const shown = f.disk();
    const newer = { ...shown, text: 'outside again', revision: '10' };
    f.files.read = vi.fn(async () => newer);
    f.files.write = vi.fn(async (_path: string, _text: string, revision: string) => {
      expect(revision).toBe(shown.revision); throw new Error('FILE_CONFLICT');
    });
    expect(await f.saver.keepLocal(shown)).toBe(false);
    expect(f.getText()).toBe('local'); expect(f.files.clearRecovery).not.toHaveBeenCalled();
    expect(f.status).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'conflict', external: newer }));
    f.saver.dispose();
  });
});


describe('恢复持久化时限与监听补查', () => {
  it('连续输入不会无限推迟恢复快照，每个时间窗保存最新正文', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      for (let index = 0; index < 10; index++) {
        f.setText(`continuous draft ${index}`);
        await vi.advanceTimersByTimeAsync(60);
      }
      expect(vi.mocked(f.files.saveRecovery).mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(f.files.saveRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'continuous draft 9' }));
      expect(f.files.write).not.toHaveBeenCalled();
    } finally { f.saver.dispose(); vi.useRealTimers(); }
  });

  it('保存期间收到的外部变化在当前保存结束后自动补查', async () => {
    const f = fixture();
    const write = f.files.write;
    let releaseWrite!: () => void;
    const release = new Promise<void>(resolve => { releaseWrite = resolve; });
    let committed = false;
    f.files.write = vi.fn(async (path: string, text: string, revision: string) => {
      const saved = await write(path, text, revision);
      committed = true;
      await release;
      return saved;
    });
    f.setText('saved local');
    const saving = f.saver.flush();
    await vi.waitFor(() => expect(committed).toBe(true));
    f.external('external after successful write');
    await f.saver.checkExternal();
    expect(f.files.read).not.toHaveBeenCalled();
    releaseWrite();
    expect(await saving).toBe(true);
    await vi.waitFor(() => expect(f.getText()).toBe('external after successful write'));
    expect(f.disk().text).toBe('external after successful write');
    f.saver.dispose();
  });
});
