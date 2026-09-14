/** 文件职责：验证原生窗口请求串行、过期结果隔离和错误回退。 */
import { describe, expect, it, vi } from 'vitest';
import { WindowMaterialController } from './window-material';

describe('窗口材质协调', () => {
  it('同一材质切换明暗时仍同步原生主题，避免沿用系统默认染色', async () => {
    const native = vi.fn().mockResolvedValue(true);
    const root = document.createElement('div');
    const controller = new WindowMaterialController(root, native);
    await controller.update('acrylic', 'dark');
    await controller.update('acrylic', 'light');
    await controller.update('acrylic', 'system');
    expect(native.mock.calls).toEqual([['acrylic', 'dark'], ['acrylic', 'light'], ['acrylic', 'system']]);
    expect(root.dataset.windowTransparent).toBe('true');
  });
  it('快速切回普通主题时，旧透明请求不得重新打开透明背景', async () => {
    const root = document.createElement('div');
    let finish!: (value: boolean) => void;
    const native = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; })).mockResolvedValue(true);
    const controller = new WindowMaterialController(root, native);
    const first = controller.update('transparent');
    await Promise.resolve();
    const last = controller.update('opaque');
    expect(native).toHaveBeenCalledTimes(1);
    finish(true);
    await first;
    expect(root.dataset.windowTransparent).toBe('false');
    await last;
    expect(native.mock.calls.map(call => call[0])).toEqual(['transparent', 'opaque']);
    expect(root.dataset.windowTransparent).toBe('false');
  });
  it('只有原生成功才透明，失败后仍能继续切换', async () => {
    const root = document.createElement('div');
    const native = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('OS failure')).mockResolvedValue(true);
    const controller = new WindowMaterialController(root, native);
    await controller.update('acrylic');
    expect(root.dataset.windowTransparent).toBe('false');
    await expect(controller.update('blur')).rejects.toThrow('OS failure');
    expect(root.dataset.windowTransparent).toBe('false');
    await controller.update('transparent');
    expect(root.dataset.windowTransparent).toBe('true');
    const reset = controller.update('opaque');
    expect(root.dataset.windowTransparent).toBe('false');
    await reset;
  });
});
