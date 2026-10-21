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
  it('自动合并产生的新版本必须等待对端确认', async () => {
    const a = device(), b = device(); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id);
    await left.receive(await right.offer()); await right.receive(await left.offer());
    a.edit('甲改\n\n乙\n'); b.edit('甲\n\n乙改\n');
    await right.receive(await left.offer());
    let record = right.snapshot().records[id];
    expect(record.document.revisions[record.document.head].content.text).toBe('甲改\n\n乙改\n');
    expect(record.binding?.acknowledged).not.toBe(record.document.head);
    await left.receive(await right.offer()); await right.receive(await left.offer());
    record = right.snapshot().records[id];
    expect(record.binding?.acknowledged).toBe(record.document.head);
  });
  it('收到对端版本并成功写入后立即确认，写入失败不能确认', async () => {
    const a = device(), b = device(); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id);
    await left.receive(await right.offer()); await right.receive(await left.offer());
    a.edit('手机修改');
    await right.receive(await left.offer());
    let record = right.snapshot().records[id];
    expect(record.binding?.acknowledged).toBe(record.document.head);
    a.edit('写入失败'); b.crash();
    await right.receive(await left.offer());
    record = right.snapshot().records[id];
    expect(record.pending).toBeDefined();
    expect(record.binding?.acknowledged).not.toBe(record.pending?.target);
  });
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
    expect(offer.documents[0].revisions[offer.documents[0].head]).toMatchObject(content.get('healthy')!);
    expect(engine.snapshot().records[missing].error).toContain('missing');
  });
  it('本机正在输入时本轮暂缓该文档且不记录同步失败', async () => {
    const a = device(); const engine = a.engine();
    await engine.load(); const id = await engine.enable('local', 'project');
    a.edit('编辑中的正文');
    a.port.read = async () => { throw new Error('SYNC_DEFER: 正在输入或编辑画布'); };
    expect((await engine.offer()).documents).toHaveLength(0);
    expect(engine.deferred).toBe(true);
    expect(engine.snapshot().records[id].error).toBeUndefined();
    // 交互结束后下一轮直接补发新版本，不经过“待处理”错误状态。
    a.port.read = async () => ({ ...a.disk() });
    const next = await engine.offer();
    expect(engine.deferred).toBe(false);
    expect(next.documents[0].revisions[next.documents[0].head].text).toBe('编辑中的正文');
  });
  it('本机正在输入时接收到的远端版本保留待写日志且不记录同步失败', async () => {
    const a = device('甲'), b = device('甲'); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id);
    b.edit('远端修改');
    const incoming = await right.offer();
    const apply = a.port.apply;
    a.port.read = async () => { throw new Error('SYNC_DEFER: 正在输入或编辑画布'); };
    a.port.apply = async () => { throw new Error('SYNC_DEFER: 正在输入或编辑画布'); };
    await left.receive(incoming);
    let record = left.snapshot().records[id];
    expect(left.deferred).toBe(true);
    expect(record.error).toBeUndefined(); expect(record.pending).toBeDefined();
    // 交互结束后的下一轮按待写日志补写，不需要用户处理错误。
    a.port.read = async () => ({ ...a.disk() }); a.port.apply = apply;
    await left.offer();
    record = left.snapshot().records[id];
    expect(a.disk().text).toBe('远端修改');
    expect(record.pending).toBeUndefined(); expect(record.error).toBeUndefined();
  });
  it('本机正文超过上限后保留可加载的旧版本，缩小正文后继续同步', async () => {
    const a = device(); let engine = a.engine(); await engine.load(); const id = await engine.enable('local', 'project');
    a.edit('大'.repeat(400000)); expect((await engine.offer()).documents).toHaveLength(0);
    expect(engine.snapshot().records[id].error).toContain('SYNC_LIMIT');
    engine = a.engine(); await engine.load(); a.edit('缩小后的正文');
    const next = await engine.offer(); expect(next.documents[0].revisions[next.documents[0].head].text).toBe('缩小后的正文');
  });
  it('收敛后交换不传输正文，新修改只携带补丁', async () => {
    const long = `甲\n\n${'长'.repeat(2000)}\n\n乙\n`;
    const a = device(long), b = device(long); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id);
    await left.receive(await right.offer());
    const idle = await left.offer();
    expect(Object.keys(idle.documents[0].revisions)).toHaveLength(0);
    await right.receive(idle); await left.receive(await right.offer());
    a.edit(`甲改\n\n${'长'.repeat(2000)}\n\n乙\n`);
    const delta = await left.offer();
    const wire = delta.documents[0].revisions[delta.documents[0].head];
    expect(wire.base).toBeDefined(); expect(wire.text).toBe('');
    expect(JSON.stringify(delta).length).toBeLessThan(long.length);
    await right.receive(delta);
    expect(b.disk().text).toBe(`甲改\n\n${'长'.repeat(2000)}\n\n乙\n`);
  });
  it('对端状态重建后拒绝增量并以全量恢复', async () => {
    const a = device('首段\n\n尾段\n'), b = device('首段\n\n尾段\n'); const left = a.engine(), right = b.engine();
    await left.load(); await right.load(); const id = await left.enable('local', 'project');
    await right.receive(await left.offer()); await right.accept(id); await left.receive(await right.offer());
    const rebuilt = device().engine(); await rebuilt.load();
    await expect(rebuilt.receive(await left.offer())).rejects.toThrow('SYNC_BASE_MISSING');
    expect(rebuilt.snapshot().records[id]).toBeUndefined();
    const request = await rebuilt.offer();
    expect(request.needsFull).toBe(true);
    await left.receive(request);
    const full = await left.offer();
    expect(full.documents[0].revisions[full.documents[0].head].text).toContain('首段');
    await rebuilt.receive(full);
    expect(rebuilt.snapshot().records[id].document.head).toBe(full.documents[0].head);
    expect((await rebuilt.offer()).needsFull).toBeUndefined();
  });
});
