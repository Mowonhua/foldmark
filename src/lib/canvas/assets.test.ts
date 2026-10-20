import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanvasAssetPort, MAX_CANVAS_IMAGE_BYTES, nativeSaveCanvasFile, validateCanvasAsset, validateCanvasImage } from './assets';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
const local = { setItem: vi.fn(), getItem: vi.fn() };
beforeAll(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('localStorage', local); });
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afooAAAAASUVORK5CYII='), c => c.charCodeAt(0));

describe('不可变画布附件', () => {
  it('同目录文档和新端口复用已持久化图片，重命名文档不改变引用', async () => {
    const port = createCanvasAssetPort(false);
    const first = await port.put('/shared/one.md', png, 'image/png');
    const again = await createCanvasAssetPort(false).put('/shared/two.md', png, 'image/png');
    expect(again).toEqual(first);
    expect(first.path).toMatch(/^\.assets\/[a-f0-9]{64}\.png$/);
    expect(await createCanvasAssetPort(false).read('/shared/renamed.md', first)).toEqual(png);
    await expect(port.read('/elsewhere/one.md', first)).rejects.toThrow();
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it('拒绝路径逃逸、格式伪装与超大图片，读取损坏附件时报告错误', async () => {
    const port = createCanvasAssetPort(false);
    const asset = await port.put('/validation/doc.md', png, 'image/png');
    for (const path of ['../secret.png', '/absolute.png', `.assets/../${asset.id}.png`, `.assets/${asset.id}.svg`]) {
      expect(() => validateCanvasAsset({ ...asset, path })).toThrow();
    }
    expect(() => validateCanvasImage(png, 'image/jpeg')).toThrow();
    expect(() => validateCanvasImage(new Uint8Array(MAX_CANVAS_IMAGE_BYTES + 1), 'image/png')).toThrow();
    await expect(port.read('/validation/doc.md', { ...asset, id: 'f'.repeat(64), path: `.assets/${'f'.repeat(64)}.png` })).rejects.toThrow();
    native.invoke.mockResolvedValue(Array.from(png, (byte, index) => index === png.length - 1 ? byte ^ 1 : byte));
    await expect(createCanvasAssetPort(true).read('D:/doc.md', asset)).rejects.toThrow('摘要');
  });

  it('并发导入同一图片复用首次写入记录，Windows 路径按目录共享', async () => {
    const port = createCanvasAssetPort(false);
    const [first, second] = await Promise.all([
      port.put('D:\\Notes\\one.md', png, 'image/png'),
      port.put('d:/notes/two.md', png, 'image/png'),
    ]);
    expect(first).toEqual(second);
    expect(await port.read('D:/NOTES/renamed.md', first)).toEqual(png);
  });

  it('保存开始时取得独立字节快照，调用方复用缓冲区不会写入损坏附件', async () => {
    const port = createCanvasAssetPort(false);
    const input = png.slice();
    const saving = port.put('/reused-buffer/doc.md', input, 'image/png');
    input[input.length - 1] ^= 1;
    const asset = await saving;
    expect(await port.read('/reused-buffer/doc.md', asset)).toEqual(png);
  });

  it('原生上传和导出使用二进制请求体，中文路径只通过 ASCII 元数据头传递', async () => {
    const browser = createCanvasAssetPort(false);
    const asset = await browser.put('/binary/doc.md', png, 'image/png');
    native.invoke.mockClear(); native.invoke.mockResolvedValueOnce(asset).mockResolvedValueOnce(undefined);
    await createCanvasAssetPort(true).put('D:/项目/图 & +.md', png, 'image/png');
    const [name, body, options] = native.invoke.mock.calls[0];
    expect(name).toBe('put_canvas_asset'); expect(body).toBeInstanceOf(Uint8Array); expect(body).toEqual(png);
    expect(options.headers['x-taskrail-canvas']).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(decodeURIComponent(options.headers['x-taskrail-canvas']))).toEqual({ documentPath: 'D:/项目/图 & +.md', mimeType: 'image/png' });
    await nativeSaveCanvasFile('D:/项目/导出.png', png);
    const [exportName, exportBytes, exportOptions] = native.invoke.mock.calls[1];
    expect(exportName).toBe('save_canvas_bundle'); expect(exportBytes).toBe(png);
    expect(JSON.parse(decodeURIComponent(exportOptions.headers['x-taskrail-canvas']))).toEqual({ path: 'D:/项目/导出.png' });
    native.invoke.mockResolvedValueOnce(png.slice().buffer);
    expect(await createCanvasAssetPort(true).read('D:/项目/图 & +.md', asset)).toEqual(png);
  });
});
