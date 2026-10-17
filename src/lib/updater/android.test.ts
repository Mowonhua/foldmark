/** Android 更新只跨原生边界，验证事件释放与安装授权的可重试行为。 */
import { beforeEach, expect, it, vi } from 'vitest';
import { AndroidUpdatePort } from './android';
const native = vi.hoisted(() => ({ invoke: vi.fn(), unregister: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, addPluginListener: native.listen }));
beforeEach(() => {
  vi.clearAllMocks();
  native.listen.mockResolvedValue({ unregister: native.unregister });
  native.invoke.mockImplementation(async (command: string) => {
    if (command.endsWith('checkUpdate')) return { available: true, version: '0.8.0', currentVersion: '0.7.0' };
    if (command.endsWith('downloadUpdate')) return { downloadedBytes: 200 };
    return { status: 'installer-opened' };
  });
});
it('下载成功和失败都移除进度监听，只有原生校验成功才完成下载', async () => {
  const candidate = (await new AndroidUpdatePort().check())!;
  const progress = vi.fn();
  await candidate.download(progress);
  expect(progress).toHaveBeenCalledWith({ downloadedBytes: 200 });
  expect(native.unregister).toHaveBeenCalledTimes(1);
  native.invoke.mockRejectedValueOnce(new Error('签名错误'));
  await expect(candidate.download(progress)).rejects.toThrow('签名错误');
  expect(native.unregister).toHaveBeenCalledTimes(2);
});
it('未知来源授权不足时保留候选允许重试，系统安装器接管后应用继续运行', async () => {
  const candidate = (await new AndroidUpdatePort().check())!;
  expect(candidate.keepsAppRunning).toBe(true);
  native.invoke.mockResolvedValueOnce({ status: 'permission-required' });
  await expect(candidate.install()).rejects.toThrow('安装权限');
  await expect(candidate.install()).resolves.toBeUndefined();
  await candidate.close();
  expect(native.invoke).toHaveBeenLastCalledWith('plugin:foldmark-mobile|closeUpdate');
});
it('原生没有新版本时不创建下载会话', async () => {
  native.invoke.mockResolvedValueOnce({ available: false, currentVersion: '0.7.0' });
  expect(await new AndroidUpdatePort().check()).toBeNull();
});
