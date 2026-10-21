/**
 * 文件职责：验证桌面更新适配器保持原生累计进度和平台安装语义。
 * 定义范围：检查结果、进度转发、安装后重启及候选释放。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriUpdatePort } from './tauri';

const native = vi.hoisted(() => ({ invoke: vi.fn(), relaunch: vi.fn(), channels: [] as { onmessage?: (message: unknown) => void }[] }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage?: (message: unknown) => void;
    constructor() { native.channels.push(this); }
  },
}));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: native.relaunch }));

const update = { version: '0.1.0-alpha.2', currentVersion: '0.1.0-alpha.1', body: '更新说明' };
const installCalls = () => native.invoke.mock.calls.filter(([command]) => command === 'desktop_update_install').length;

beforeEach(() => {
  vi.resetAllMocks();
  native.channels.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Tauri 更新端口', () => {
  it('原生没有新版本时返回 null', async () => {
    native.invoke.mockResolvedValue(null);
    expect(await new TauriUpdatePort().check()).toBeNull();
    expect(native.invoke).toHaveBeenCalledWith('desktop_update_check');
  });

  it('转发原生累计进度并等待下载命令完成', async () => {
    native.invoke.mockResolvedValueOnce(update);
    const candidate = await new TauriUpdatePort().check();
    native.invoke.mockImplementationOnce(async () => {
      const channel = native.channels.at(-1)!;
      channel.onmessage?.({ downloadedBytes: 25, totalBytes: 100 });
      channel.onmessage?.({ downloadedBytes: 100, totalBytes: 100 });
    });
    const progress = vi.fn();
    await candidate!.download(progress);
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { downloadedBytes: 25, totalBytes: 100 },
      { downloadedBytes: 100, totalBytes: 100 },
    ]);
    expect(native.invoke).toHaveBeenLastCalledWith('desktop_update_download', expect.objectContaining({ onEvent: native.channels[0] }));
  });

  it('关闭候选调用原生释放', async () => {
    native.invoke.mockResolvedValueOnce(update);
    const candidate = await new TauriUpdatePort().check();
    await candidate!.close();
    expect(native.invoke).toHaveBeenLastCalledWith('desktop_update_close');
  });

  it('Windows 安装器负责退出和重启，不再额外重启旧进程', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    native.invoke.mockResolvedValueOnce(update).mockResolvedValue(undefined);
    const candidate = await new TauriUpdatePort().check();
    await candidate!.install();
    expect(installCalls()).toBe(1);
    expect(native.relaunch).not.toHaveBeenCalled();
  });

  it('其他平台安装成功后重启，重启失败重试不会重复消费安装包', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    native.invoke.mockResolvedValueOnce(update).mockResolvedValue(undefined);
    const candidate = await new TauriUpdatePort().check();
    native.relaunch.mockRejectedValueOnce(new Error('relaunch failed'));
    await expect(candidate!.install()).rejects.toThrow('relaunch failed');
    await candidate!.install();
    expect(installCalls()).toBe(1);
    expect(native.relaunch).toHaveBeenCalledTimes(2);
  });
});
