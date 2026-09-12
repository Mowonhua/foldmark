/**
 * 文件职责：验证 Tauri 适配器保持插件的签名校验和平台退出语义。
 * 定义范围：检查超时、事件累计进度、安装及重启失败恢复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from '@tauri-apps/plugin-updater';
import { TauriUpdatePort } from './tauri';

const native = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: native.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: native.relaunch }));

function platformUpdate() {
  const update = {
    version: '0.1.0-alpha.2', currentVersion: '0.1.0-alpha.1', body: '更新说明',
    download: vi.fn<Update['download']>(async () => {}),
    install: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  native.check.mockResolvedValue(update);
  return update;
}

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Tauri 更新端口', () => {
  it('使用有限检查超时并保留无更新结果', async () => {
    native.check.mockResolvedValue(null);
    expect(await new TauriUpdatePort().check()).toBeNull();
    expect(native.check).toHaveBeenCalledWith({ timeout: 15000 });
  });

  it('转换分块事件为累计字节，下载完成事件仍等待签名结果', async () => {
    const update = platformUpdate();
    update.download.mockImplementation(async progress => {
      progress?.({ event: 'Started', data: { contentLength: 100 } });
      progress?.({ event: 'Progress', data: { chunkLength: 25 } });
      progress?.({ event: 'Progress', data: { chunkLength: 75 } });
      progress?.({ event: 'Finished' });
      throw new Error('signature mismatch');
    });
    const candidate = await new TauriUpdatePort().check(); const progress = vi.fn();
    expect(candidate).toMatchObject({ version: update.version, currentVersion: update.currentVersion, body: update.body });
    await expect(candidate!.download(progress)).rejects.toThrow('signature mismatch');
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { downloadedBytes: 0, totalBytes: 100 }, { downloadedBytes: 25, totalBytes: 100 }, { downloadedBytes: 100, totalBytes: 100 },
    ]);
    expect(update.install).not.toHaveBeenCalled();
  });

  it('服务器未提供内容长度时进度总量保持未知', async () => {
    const update = platformUpdate();
    update.download.mockImplementation(async progress => {
      progress?.({ event: 'Started', data: {} });
      progress?.({ event: 'Progress', data: { chunkLength: 30 } });
    });
    const candidate = await new TauriUpdatePort().check(); const progress = vi.fn();
    await candidate!.download(progress);
    expect(progress).toHaveBeenLastCalledWith({ downloadedBytes: 30, totalBytes: undefined });
    await candidate!.close(); expect(update.close).toHaveBeenCalledTimes(1);
  });

  it('Windows 安装器负责退出和重启，不再额外重启旧进程', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    const update = platformUpdate(); const candidate = await new TauriUpdatePort().check();
    await candidate!.install();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(native.relaunch).not.toHaveBeenCalled();
  });

  it('其他平台安装成功后重启，重启失败重试不会重复消耗安装包', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    const update = platformUpdate(); const candidate = await new TauriUpdatePort().check();
    native.relaunch.mockRejectedValueOnce(new Error('relaunch failed'));
    await expect(candidate!.install()).rejects.toThrow('relaunch failed');
    await candidate!.install();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(native.relaunch).toHaveBeenCalledTimes(2);
  });
});
