import { describe, expect, it } from 'vitest';
import { SyncEngine } from './engine';
import type { DocumentContent, SyncState } from './contracts';
const text = (value: string): DocumentContent => ({ text: value, name: '项目', archived: false });
function device(initial = '甲\n\n乙\n') {
  let disk = text(initial); let saved: SyncState | null = null; let fail = false;
  const port = { read: async () => ({ ...disk }), apply: async (_: string, expected: DocumentContent, next: DocumentContent) => {
    if (JSON.stringify(disk) !== JSON.stringify(expected)) throw new Error('changed');
    disk = { ...next }; if (fail) { fail = false; throw new Error('crash after write'); }
  }, accept: async () => 'local' };
  const store = { load: async () => saved && structuredClone(saved), save: async (value: SyncState) => { saved = structuredClone(value); } };
  return { port, store, edit: (value: string) => { disk = text(value); }, disk: () => disk, crash: () => { fail = true; }, engine: () => new SyncEngine(port, store) };
}
describe('同步持久化', () => {
  it('取消选择撤回尚未接收的文档，重启和旧请求重传不恢复接收提示', async () => {
    const a = device(), b = device(); const left = a.engine(); let right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    const before = await left.offer(); await right.receive(before);
    expect(right.snapshot().records[id]).toBeDefined();
    await left.disable(id); await right.receive(await left.offer());
    expect(right.snapshot().records[id]).toBeUndefined();
    right = b.engine(); await right.load(); await right.receive(before);
    expect(right.snapshot().records[id]).toBeUndefined();
    await left.enable('local', 'project'); await right.receive(await left.offer());
    expect(right.snapshot().records[id]).toBeDefined();
  });
  it('取消选择不删除对端已接收的正文和关联', async () => {
    const a = device(), b = device(); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id);
    await left.disable(id); await right.receive(await left.offer());
    expect(right.snapshot().records[id].binding?.localId).toBe('local');
    expect(b.disk().text).toBe('甲\n\n乙\n');
  });
  it('明确关联已有项目不创建副本且先保留双方内容，重启后可合并', async () => {
    const a = device('电脑正文'), b = device('手机保留正文'); const left = a.engine(); let right = b.engine();
    b.port.accept = async () => { throw new Error('不能新建副本'); };
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id, 'local');
    expect(b.disk().text).toBe('手机保留正文');
    right = b.engine(); await right.load();
    const record = right.snapshot().records[id]; const conflict = record.conflict!;
    expect(record.binding?.localId).toBe('local');
    expect(record.document.revisions[conflict.remote].content.text).toBe('电脑正文');
    await right.resolve(id, conflict.local, conflict.remote, text('电脑正文\n手机保留正文'));
    await left.receive(await right.offer()); await right.receive(await left.offer());
    expect(a.disk()).toEqual(b.disk());
  });
  it('拒绝关联已被占用的本机项目或把项目关联到灵感簿', async () => {
    const a = device(), b = device(); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.enable('local', 'project');
    await expect(right.accept(id, 'local')).rejects.toThrow('SYNC_BINDING');
    await expect(right.accept(id, 'inspiration')).rejects.toThrow('SYNC_BINDING');
    expect(right.snapshot().records[id].binding).toBeUndefined();
    expect(b.disk().text).toBe('甲\n\n乙\n');
  });
  it('损坏的同步记录阻止后续写入，不能回退为空状态覆盖原文件', async () => {
    let writes = 0;
    const engine = new SyncEngine({ read: async () => text('正文'), apply: async () => {}, accept: async () => 'local' }, {
      load: async () => ({ version: 9, records: {} }) as unknown as SyncState,
      save: async () => { writes++; },
    });
    await expect(engine.load()).rejects.toThrow('SYNC_STATE');
    await expect(engine.enable('local', 'project')).rejects.toThrow('SYNC_STATE');
    await expect(engine.reset()).rejects.toThrow('SYNC_STATE'); expect(writes).toBe(0);
  });
  it('往返重复交换及独立修改最终收敛', async () => {
    const a = device(), b = device(); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id);
    a.edit('甲改\n\n乙\n'); b.edit('甲\n\n乙改\n');
    await left.receive(await right.offer()); await right.receive(await left.offer()); await left.receive(await right.offer());
    expect(a.disk().text).toBe('甲改\n\n乙改\n'); expect(b.disk()).toEqual(a.disk());
    const before = await left.offer(); await left.receive(await right.offer()); expect(await left.offer()).toEqual(before);
  });
  it('写入后退出由日志恢复而不重复修改', async () => {
    const a = device(), b = device(); const left = a.engine(); let right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id);
    a.edit('新版本'); b.crash(); await right.receive(await left.offer());
    right = b.engine(); await right.load(); await right.offer();
    expect(b.disk().text).toBe('新版本'); expect(right.snapshot().records[id].pending).toBeUndefined();
  });
  it('处理冲突期间的新编辑使旧解决请求失效', async () => {
    const a = device(), b = device(); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id);
    a.edit('电脑'); b.edit('手机'); await left.receive(await right.offer());
    const conflict = left.snapshot().records[id].conflict!;
    a.edit('更新的电脑');
    await expect(left.resolve(id, conflict.local, conflict.remote, text('选择'))).rejects.toThrow('SYNC_CHANGED');
    expect(a.disk().text).toBe('更新的电脑');
  });
  it('暂停保留文件并拒绝远端覆盖', async () => {
    const a = device(), b = device(); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id); await right.disable(id);
    a.edit('远端'); await right.receive(await left.offer()); expect(b.disk().text).toBe('甲\n\n乙\n');
  });
  it('双方确认后压缩历史，后续双端编辑仍可合并', async () => {
    const a = device(), b = device(); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id);
    a.edit('初次改动\n\n乙\n');
    await right.receive(await left.offer()); await left.receive(await right.offer()); await right.receive(await left.offer());
    expect(Object.keys(left.snapshot().records[id].document.revisions)).toHaveLength(1);
    a.edit('再次改动\n\n乙\n'); b.edit('初次改动\n\n手机改动\n');
    await left.receive(await right.offer()); await right.receive(await left.offer());
    expect(a.disk().text).toBe('再次改动\n\n手机改动\n'); expect(b.disk()).toEqual(a.disk());
  });
  it('首次关联已有灵感簿保留双方，确认合并后重传不会恢复旧冲突', async () => {
    const a = device('电脑灵感'), b = device('手机灵感'); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('inspiration', 'inspiration');
    await right.enable('inspiration', 'inspiration'); await right.receive(await left.offer());
    expect(b.disk().text).toBe('手机灵感');
    const conflict = right.snapshot().records[id].conflict!;
    expect(conflict).toBeDefined();
    await right.resolve(id, conflict.local, conflict.remote, text('电脑灵感\n手机灵感'));
    await left.receive(await right.offer()); await right.receive(await left.offer());
    expect(a.disk()).toEqual(b.disk()); expect(a.disk().text).toBe('电脑灵感\n手机灵感');
    expect(right.snapshot().records[id].conflict).toBeUndefined();
  });
  it('一个文档无法读取时其他文档仍交换，名称与归档与正文一起确认', async () => {
    const content = new Map([['missing', text('暂时可读')], ['healthy', text('正文')]]);
    const engine = new SyncEngine({ read: async id => { const value = content.get(id); if (!value) throw new Error('missing'); return value; }, apply: async () => {}, accept: async () => null }, { load: async () => null, save: async () => {} });
    await engine.load(); const missing = await engine.enable('missing', 'project'); const healthy = await engine.enable('healthy', 'project');
    content.delete('missing'); content.set('healthy', { text: '正文', name: '新名称', archived: true });
    const offer = await engine.offer();
    expect(offer.documents.map(document => document.id)).toEqual([healthy]);
    expect(offer.documents[0].revisions[offer.documents[0].head].content).toEqual(content.get('healthy'));
    expect(engine.snapshot().records[missing].error).toContain('missing');
  });
  it('本机正文超过上限后保留可加载的旧版本，缩小正文后继续同步', async () => {
    const a = device(); let engine = a.engine(); await engine.load(); const id = await engine.enable('local', 'project');
    a.edit('大'.repeat(400000)); expect((await engine.offer()).documents).toHaveLength(0);
    expect(engine.snapshot().records[id].error).toContain('SYNC_LIMIT');
    engine = a.engine(); await engine.load(); a.edit('缩小后的正文');
    const next = await engine.offer(); expect(next.documents[0].revisions[next.documents[0].head].content.text).toBe('缩小后的正文');
  });
});
