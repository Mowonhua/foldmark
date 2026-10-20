/** 文件职责：验证图片保存顺序、交互合并和失败重试，不挂载画布引擎。 */
import { describe, expect, it, vi } from 'vitest';
import { CanvasSaveQueue, type CanvasScene } from './save-queue';
import type { CanvasAsset, CanvasSession } from './types';

const asset: CanvasAsset = { id: 'a'.repeat(64), path: `.assets/${'a'.repeat(64)}.png`, mimeType: 'image/png', size: 3, created: 1 };
const scene = (title = '图'): CanvasScene => ({ title, elements: [{ id: 'image', type: 'image', fileId: 'file', x: 0, y: 0, width: 20, height: 20 }], files: { file: { id: 'file', dataURL: 'data:image/png;base64,AQID', mimeType: 'image/png', created: 1 } } });
function fixture() {
  const events: string[] = [];
  const session: CanvasSession = { document: { version: 1, id: 'canvas-1', title: '图', elements: [], files: {} }, readOnly: false, commit: vi.fn(() => { events.push('commit'); return true; }), close() {} };
  const put = vi.fn(async () => { events.push('put'); return asset; });
  const queue = new CanvasSaveQueue({ session, documentPath: '/work/a.md', assets: { put, read: vi.fn() }, onStatus: vi.fn() });
  return { queue, session, put, events };
}
describe('画布提交队列', () => {
  it('先保存图片再提交引用，Markdown 不含 data URL', async () => {
    const f = fixture(); f.queue.update(scene());
    expect(await f.queue.flush()).toBe(true);
    expect(f.events).toEqual(['put', 'commit']);
    const document = vi.mocked(f.session.commit).mock.calls[0][0];
    expect(document.files.file.path).toBe(asset.path);
    expect(JSON.stringify(document)).not.toContain('data:');
    f.queue.dispose();
  });
  it('拖动时不提交中间帧，松手后只提交最终场景', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.queue.setInteracting(true); f.queue.update(scene('中间'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.session.commit).not.toHaveBeenCalled();
    f.queue.update(scene('最终')); f.queue.setInteracting(false);
    expect(await f.queue.flush()).toBe(true);
    expect(f.session.commit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.session.commit).mock.calls[0][0].title).toBe('最终');
    f.queue.dispose(); vi.useRealTimers();
  });
  it('附件写入失败不提交正文，重试保留同一场景', async () => {
    const f = fixture(); f.put.mockRejectedValueOnce(new Error('disk full'));
    f.queue.update(scene()); expect(await f.queue.flush()).toBe(false);
    expect(f.session.commit).not.toHaveBeenCalled();
    expect(await f.queue.flush()).toBe(true);
    expect(f.session.commit).toHaveBeenCalledTimes(1); f.queue.dispose();
  });
  it('保存期间的新变化仍按顺序提交，复用已保存图片', async () => {
    const f = fixture(); let release!: (asset: CanvasAsset) => void;
    f.put.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.queue.update(scene('之前')); const pending = f.queue.flush();
    await Promise.resolve(); f.queue.update(scene('之后')); release(asset);
    expect(await pending).toBe(true);
    expect(vi.mocked(f.session.commit).mock.calls.map(([doc]) => doc.title)).toEqual(['之前', '之后']);
    expect(f.put).toHaveBeenCalledTimes(1); f.queue.dispose();
  });
  it('源块失效时拒绝提交，不能误报已保存', async () => {
    const f = fixture(); vi.mocked(f.session.commit).mockReturnValue(false);
    f.queue.update(scene()); expect(await f.queue.flush()).toBe(false); f.queue.dispose();
  });
  it('相同 fileId 的图片字节改变时重新保存，不误用旧摘要', async () => {
    const f = fixture(); f.session.document.files.file = { ...asset, id: 'b'.repeat(64), path: `.assets/${'b'.repeat(64)}.png` };
    f.queue.update(scene()); expect(await f.queue.flush()).toBe(true);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.session.commit).mock.calls[0][0].files.file.id).toBe(asset.id);
    f.queue.dispose();
  });
  it('超大内嵌图片在 Base64 解码之前被拒绝', async () => {
    const f = fixture(); const next = scene(); next.files.file.dataURL = 'data:image/png;base64,' + 'A'.repeat(28 * 1024 * 1024);
    const decode = vi.spyOn(globalThis, 'atob');
    f.queue.update(next); expect(await f.queue.flush()).toBe(false);
    expect(decode).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
    decode.mockRestore(); f.queue.dispose();
  });
});
