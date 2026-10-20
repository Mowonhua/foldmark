import { describe, expect, it } from 'vitest';
import { SyncEngine } from './engine';
import { ASSET_CHUNK_BYTES } from './attachments';
import type { CanvasAsset } from '../canvas/types';
import type { DocumentContent, SyncAttachment, SyncDocumentPort, SyncState } from './contracts';

const content = (text: string): DocumentContent => ({ text, name: '白板', archived: false });
async function image(size = ASSET_CHUNK_BYTES * 2 + 20): Promise<SyncAttachment> {
  const bytes = new Uint8Array(size); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  return { bytes, asset: { id, path: `.assets/${id}.png`, mimeType: 'image/png', size, created: 1 } };
}
const board = (asset: CanvasAsset) => '```canvas\n' + JSON.stringify({ version: 1, id: 'board', title: '白板', elements: [], files: { [asset.id]: asset } }) + '\n```\n';
function device(initial: string, attachments: SyncAttachment[] = []) {
  let disk = content(initial); let saved: SyncState | null = null; let fail = false;
  const images = new Map(attachments.map(item => [item.asset.id, item.bytes]));
  const writes: string[] = [];
  const port: SyncDocumentPort = {
    read: async () => ({ ...disk }),
    apply: async (_, expected, next) => { expect(disk).toEqual(expected); writes.push('document'); disk = { ...next }; },
    readAsset: async (_, asset) => { const bytes = images.get(asset.id); if (!bytes) throw new Error('missing'); return bytes; },
    writeAsset: async (_, item) => { if (fail) throw new Error('image write failed'); images.set(item.asset.id, item.bytes); writes.push('asset'); },
    accept: async (_, __, next, incoming = []) => {
      for (const item of incoming) { await port.writeAsset!('local', item); }
      disk = { ...next }; writes.push('document'); return 'local';
    },
  };
  const store = { load: async () => saved && structuredClone(saved), save: async (state: SyncState) => { saved = structuredClone(state); } };
  return { engine: new SyncEngine(port, store), restart: () => new SyncEngine(port, store), disk: () => disk, images, writes, edit: (text: string) => { disk = content(text); }, fail: (value: boolean) => { fail = value; } };
}

describe('画布附件同步', () => {
  it('首次接收先完成附件，再创建正文；未收齐时拒绝创建半成品文档', async () => {
    const attachment = await image(40), a = device(board(attachment.asset), [attachment]), b = device('');
    await a.engine.load(); await b.engine.load(); const id = await a.engine.enable('local', 'project');
    // 首次只交换能力，旧端不能收到无法接收附件的画布版本。
    await b.engine.receive(await a.engine.offer()); await a.engine.receive(await b.engine.offer());
    await b.engine.receive(await a.engine.offer());
    await expect(b.engine.accept(id)).rejects.toThrow('SYNC_ASSET_PENDING'); expect(b.writes).toHaveLength(0);
    await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    await b.engine.accept(id);
    expect(b.writes).toEqual(['asset', 'document']); expect(b.disk().text).toBe(board(attachment.asset));
  });
  it('缺失图片按块拉取，完整落盘之前不应用或确认正文，已有图片不重传', async () => {
    const attachment = await image(); const a = device('旧正文', [attachment]), b = device('');
    await a.engine.load(); await b.engine.load(); const id = await a.engine.enable('local', 'project');
    await b.engine.receive(await a.engine.offer()); await b.engine.accept(id);
    await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    a.edit(board(attachment.asset));
    await b.engine.receive(await a.engine.offer());
    let record = b.engine.snapshot().records[id];
    expect(b.disk().text).toBe('旧正文'); expect(record.binding?.acknowledged).not.toBe(record.pending?.target);
    let chunks = 0;
    for (let round = 0; round < 8 && b.disk().text === '旧正文'; round++) {
      await a.engine.receive(await b.engine.offer()); const next = await a.engine.offer();
      chunks += next.assetChunks?.length ?? 0;
      await b.engine.receive(next);
    }
    expect(chunks).toBe(3); expect(b.images.get(attachment.asset.id)).toEqual(attachment.bytes);
    expect(b.writes.slice(-2)).toEqual(['asset', 'document']); expect(b.disk().text).toBe(board(attachment.asset));
    record = b.engine.snapshot().records[id]; expect(record.binding?.acknowledged).toBe(record.document.head);
    await a.engine.receive(await b.engine.offer());
    expect((await a.engine.offer()).assetChunks ?? []).toHaveLength(0);
  });
  it('附件写入失败保留旧正文和写入日志，重试成功后才确认', async () => {
    const attachment = await image(40), a = device('旧正文', [attachment]), b = device('');
    await a.engine.load(); await b.engine.load(); const id = await a.engine.enable('local', 'project');
    await b.engine.receive(await a.engine.offer()); await b.engine.accept(id);
    await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    a.edit(board(attachment.asset)); b.fail(true);
    await b.engine.receive(await a.engine.offer()); await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    let record = b.engine.snapshot().records[id];
    expect(b.disk().text).toBe('旧正文'); expect(record.pending).toBeDefined(); expect(record.binding?.acknowledged).not.toBe(record.pending?.target);
    b.fail(false); await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    record = b.engine.snapshot().records[id]; expect(b.disk().text).toBe(board(attachment.asset)); expect(record.pending).toBeUndefined();
    expect(record.binding?.acknowledged).toBe(record.document.head);
  });
  it('图片块篡改后拒绝正文且从零重试，未引用图片请求不能读取本机文件', async () => {
    const attachment = await image(40), a = device('旧正文', [attachment]), b = device('');
    await a.engine.load(); await b.engine.load(); const id = await a.engine.enable('local', 'project');
    await b.engine.receive(await a.engine.offer()); await b.engine.accept(id);
    await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    const unauthorized = await b.engine.offer(); unauthorized.assetRequests = [{ documentId: id, assetId: attachment.asset.id, offset: 0 }];
    await a.engine.receive(unauthorized); expect((await a.engine.offer()).assetChunks).toBeUndefined();
    a.edit(board(attachment.asset)); await b.engine.receive(await a.engine.offer()); await a.engine.receive(await b.engine.offer());
    const corrupted = await a.engine.offer(); const chunk = corrupted.assetChunks![0];
    chunk.data = chunk.data.slice(0, -4) + 'AAAA';
    await expect(b.engine.receive(corrupted)).rejects.toThrow();
    expect(b.disk().text).toBe('旧正文'); expect((await b.engine.offer()).assetRequests?.[0].offset).toBe(0);
    await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    expect(b.disk().text).toBe(board(attachment.asset));
  });
  it('分块中断并重启后保留旧正文，从零重取且完整保存后恢复确认', async () => {
    const attachment = await image(), a = device('旧正文', [attachment]), b = device(''); let right = b.engine;
    await a.engine.load(); await right.load(); const id = await a.engine.enable('local', 'project');
    await right.receive(await a.engine.offer()); await right.accept(id);
    await a.engine.receive(await right.offer()); await right.receive(await a.engine.offer());
    a.edit(board(attachment.asset)); await right.receive(await a.engine.offer());
    await a.engine.receive(await right.offer()); await right.receive(await a.engine.offer());
    expect((await right.offer()).assetRequests?.[0].offset).toBe(ASSET_CHUNK_BYTES);
    right = b.restart(); await right.load();
    expect(b.disk().text).toBe('旧正文'); expect((await right.offer()).assetRequests?.[0].offset).toBe(0);
    for (let round = 0; round < 4; round++) { await a.engine.receive(await right.offer()); await right.receive(await a.engine.offer()); }
    expect(b.disk().text).toBe(board(attachment.asset));
    const record = right.snapshot().records[id]; expect(record.binding?.acknowledged).toBe(record.document.head);
  });
  it('旧端未声明附件能力时保留本机版本，不发送带图片正文或伪造确认', async () => {
    const attachment = await image(40), a = device('旧正文', [attachment]), b = device('');
    await a.engine.load(); await b.engine.load(); const id = await a.engine.enable('local', 'project');
    await b.engine.receive(await a.engine.offer()); await b.engine.accept(id);
    const legacy = await b.engine.offer(); delete legacy.assetProtocol;
    await a.engine.receive(legacy); a.edit(board(attachment.asset));
    const next = await a.engine.offer(); expect(next.documents).toHaveLength(0);
    const record = a.engine.snapshot().records[id]; expect(record.error).toContain('SYNC_PROTOCOL');
    expect(record.binding?.acknowledged).not.toBe(record.document.head); expect(a.disk().text).toBe(board(attachment.asset));
  });
  it('此前验过的本机图片被移除后，新正文仍须重新取得附件才能确认', async () => {
    const attachment = await image(40), a = device('旧正文', [attachment]), b = device('');
    await a.engine.load(); await b.engine.load(); const id = await a.engine.enable('local', 'project');
    await b.engine.receive(await a.engine.offer()); await b.engine.accept(id);
    await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    a.edit(board(attachment.asset)); await b.engine.receive(await a.engine.offer());
    await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    b.images.delete(attachment.asset.id); a.edit(board(attachment.asset) + '\n新的说明');
    await b.engine.receive(await a.engine.offer());
    const pending = b.engine.snapshot().records[id]; expect(b.disk().text).toBe(board(attachment.asset));
    expect(pending.pending).toBeDefined(); expect(pending.binding?.acknowledged).not.toBe(pending.pending?.target);
    await a.engine.receive(await b.engine.offer()); await b.engine.receive(await a.engine.offer());
    const ready = b.engine.snapshot().records[id];
    expect(b.disk().text).toBe(board(attachment.asset) + '\n新的说明'); expect(ready.binding?.acknowledged).toBe(ready.document.head);
  });
});
