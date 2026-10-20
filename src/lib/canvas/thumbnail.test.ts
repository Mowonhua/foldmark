/** 文件职责：验证轻量内容预览及图片资源的释放边界。 */
import { describe, expect, it, vi } from 'vitest';
import { createCanvasThumbnail } from './thumbnail';
import { createCanvasDocument } from './model';

const asset = { id: 'a'.repeat(64), path: `.assets/${'a'.repeat(64)}.png`, mimeType: 'image/png' as const, size: 100, created: 1 };
const shape = (id: string, type: string, x = 0) => ({ id, type, x, y: 0, width: 100, height: 80 });

describe('画布内容预览', () => {
  it('呈现真实文字与线条路径，忽略已删除内容，转义不可信文字', () => {
    const scene = { ...createCanvasDocument(), elements: [
      { ...shape('text', 'text'), text: '<script>标题</script>\n下一步', fontSize: 20, lineHeight: 1.25 },
      { ...shape('line', 'arrow', 100), points: [[0, 0], [80, 10], [100, 80]], endArrowhead: 'arrow' },
      { ...shape('gone', 'rectangle', 5000), isDeleted: true },
    ] };
    const preview = createCanvasThumbnail(scene);
    expect(preview.element.querySelector('script')).toBeNull();
    expect(preview.element.querySelector('text')?.textContent).toBe('<script>标题</script>下一步');
    expect(preview.element.querySelectorAll('tspan')).toHaveLength(2);
    expect(preview.element.querySelector('[data-element="line"] polyline')?.getAttribute('points')).toBe('0,0 80,10 100,80');
    expect(preview.element.querySelector('[data-element="gone"]')).toBeNull();
    expect(Number(preview.element.getAttribute('viewBox')!.split(' ')[2])).toBeLessThan(500);
    preview.dispose();
  });
  it('重复图片只读取一次，卸载释放 URL，读取完成前卸载不创建 URL', async () => {
    const create = vi.fn(() => 'blob:preview'); const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    try {
      const scene = { ...createCanvasDocument(), files: { image: asset }, elements: [
        { ...shape('one', 'image'), fileId: 'image' }, { ...shape('two', 'image', 200), fileId: 'image' },
      ] };
      const read = vi.fn(async () => new Blob(['image']));
      const preview = createCanvasThumbnail(scene, read);
      await vi.waitFor(() => expect(preview.element.querySelectorAll('image[href="blob:preview"]')).toHaveLength(2));
      expect(read).toHaveBeenCalledOnce(); preview.dispose(); preview.dispose();
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:preview');
      let complete!: (blob: Blob) => void;
      const loading = createCanvasThumbnail(scene, () => new Promise(resolve => { complete = resolve; }));
      loading.dispose(); complete(new Blob(['late'])); await Promise.resolve();
      expect(create).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});
