import { describe, expect, it } from 'vitest';
import { AttachmentExchange } from './attachments';
import type { CanvasAsset } from '../canvas/types';
import type { SyncDocumentPort } from './contracts';

async function picture() {
  const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  const asset: CanvasAsset = { id, path: `.assets/${id}.png`, mimeType: 'image/png', size: bytes.length, created: 1 };
  const text = '```canvas\n' + JSON.stringify({ version: 1, id: 'board', title: '', elements: [], files: { [id]: asset } }) + '\n```';
  const documentId = crypto.randomUUID();
  const envelope = { protocol: 3 as const, documents: [], assetProtocol: 1 as const, assetChunks: [{ documentId, assetId: id, offset: 0, data: btoa(String.fromCharCode(...bytes)) }] };
  return { asset, bytes, text, documentId, envelope };
}
function port(): SyncDocumentPort {
  return { read: async () => ({ text: '', name: '白板', archived: false }), apply: async () => {}, accept: async () => null };
}
describe('附件缓存生命周期', () => {
  it('撤回待接收文档后释放完整图片，重新接收须重新请求', async () => {
    const image = await picture(), exchange = new AttachmentExchange(port());
    await expect(exchange.require(image.documentId, image.text)).rejects.toThrow('SYNC_ASSET_PENDING');
    await exchange.receive(image.envelope);
    expect((await exchange.require(image.documentId, image.text))[0].bytes).toEqual(image.bytes);
    exchange.retain(new Set());
    await expect(exchange.require(image.documentId, image.text)).rejects.toThrow('SYNC_ASSET_PENDING');
    expect((await exchange.offer(async () => undefined)).assetRequests?.[0].offset).toBe(0);
  });
  it('文档接收并持久化后释放完整图片，外部删除后不能用旧字节缓存绕过缺失请求', async () => {
    const image = await picture(), documents = port(), exchange = new AttachmentExchange(documents);
    await expect(exchange.require(image.documentId, image.text)).rejects.toThrow('SYNC_ASSET_PENDING');
    await exchange.receive(image.envelope); await exchange.require(image.documentId, image.text);
    documents.readAsset = async () => image.bytes;
    expect(await exchange.require(image.documentId, image.text, 'local')).toEqual([]);
    documents.readAsset = async () => { throw new Error('removed'); };
    await expect(exchange.require(image.documentId, image.text, 'local', true)).rejects.toThrow('SYNC_ASSET_PENDING');
  });
});
