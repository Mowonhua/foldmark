import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { createCanvasAssetPort } from './assets';
import { exportBundle, importBundle } from './bundle';
beforeAll(() => { vi.stubGlobal('crypto', webcrypto); });
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afooAAAAASUVORK5CYII='), c => c.charCodeAt(0));

describe('完整 Markdown 包', () => {
  it('完整往返只携带引用附件，先落盘后提供正文', async () => {
    const port = createCanvasAssetPort(false);
    const asset = await port.put('/bundle-source/notes.md', png, 'image/png');
    const text = '# 清单\n\n```canvas\n' + JSON.stringify({ version: 1, id: 'canvas', title: '画布', elements: [], files: { image: asset } }) + '\n```\n';
    const bytes = await exportBundle({ text, documentPath: '/bundle-source/notes.md', assets: [asset], port, filename: '清单.md' });
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual([asset.path, 'taskrail-bundle.json', '清单.md'].sort());
    const result = await importBundle({ bytes, documentPath: '/bundle-target/new.md', port });
    expect(result).toEqual({ text, filename: '清单.md' });
    expect(await port.read('/bundle-target/new.md', asset)).toEqual(png);
  });

  it('拒绝越界条目和损坏附件，在校验失败前不写入任何附件', async () => {
    const port = createCanvasAssetPort(false);
    const asset = await port.put('/bundle-validation/notes.md', png, 'image/png');
    const text = '```canvas\n' + JSON.stringify({ version: 1, id: 'canvas', title: '画布', elements: [], files: { image: asset } }) + '\n```';
    const bytes = await exportBundle({ text, documentPath: '/bundle-validation/notes.md', assets: [asset], port });
    const entries = unzipSync(bytes);
    const put = vi.fn(port.put.bind(port));
    const target = { ...port, put };
    await expect(importBundle({ bytes: zipSync({ ...entries, '../escape.md': strToU8('escape') }), documentPath: '/invalid/doc.md', port: target })).rejects.toThrow();
    const corrupt = png.slice(); corrupt[corrupt.length - 1] ^= 1;
    await expect(importBundle({ bytes: zipSync({ ...entries, [asset.path]: corrupt }), documentPath: '/invalid/doc.md', port: target })).rejects.toThrow('摘要');
    expect(put).not.toHaveBeenCalled();
  });

  it('附件写入失败时不返回可提交正文，也不忽略缺失图片', async () => {
    const source = createCanvasAssetPort(false);
    const asset = await source.put('/bundle-failure/notes.md', png, 'image/png');
    const text = '```canvas\n' + JSON.stringify({ version: 1, id: 'canvas', title: '画布', elements: [], files: { image: asset } }) + '\n```';
    const bytes = await exportBundle({ text, documentPath: '/bundle-failure/notes.md', assets: [asset], port: source });
    const rejecting = { ...source, put: vi.fn().mockRejectedValue(new Error('disk full')) };
    await expect(importBundle({ bytes, documentPath: '/disk-full/notes.md', port: rejecting })).rejects.toThrow('disk full');
    const entries = unzipSync(bytes); delete entries[asset.path];
    await expect(importBundle({ bytes: zipSync(entries), documentPath: '/missing/notes.md', port: source })).rejects.toThrow();
    await expect(exportBundle({ text, documentPath: '/not-found/notes.md', assets: [asset], port: source })).rejects.toThrow();
  });

  it('未引用图片和远程 Markdown 图片不进入完整包', async () => {
    const port = createCanvasAssetPort(false);
    const unused = await port.put('/bundle-unused/notes.md', png, 'image/png');
    const read = vi.fn(port.read.bind(port));
    const bytes = await exportBundle({ text: '![网络图片](https://example.org/image.png)', documentPath: '/bundle-unused/notes.md', assets: [unused], port: { ...port, read } });
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual(['document.md', 'taskrail-bundle.json']);
    expect(read).not.toHaveBeenCalled();
  });
});
