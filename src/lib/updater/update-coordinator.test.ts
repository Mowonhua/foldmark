/**
 * 文件职责：验证更新生命周期中的并发、失败恢复和保存边界。
 * 定义范围：使用可控平台端口覆盖下载签名结果及迟到资源释放。
 */
import { describe, expect, it, vi } from 'vitest';
import type { UpdateCandidate, UpdateOptions } from './contracts';
import { UpdateCoordinator } from './update-coordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(autoDownload?: boolean) {
  const candidate = {
    version: '0.1.0-alpha.2', currentVersion: '0.1.0-alpha.1', body: '改进更新体验',
    download: vi.fn<UpdateCandidate['download']>(async () => {}),
    install: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  const port = { check: vi.fn<() => Promise<UpdateCandidate | null>>(async () => candidate) };
  const onStatus = vi.fn<UpdateOptions['onStatus']>();
  const beforeInstall = vi.fn(async () => true);
  const afterInstallFailure = vi.fn();
  const coordinator = new UpdateCoordinator({ port, autoDownload, onStatus, beforeInstall, afterInstallFailure });
  return { coordinator, candidate, port, onStatus, beforeInstall, afterInstallFailure };
}

describe('更新检查与后台下载', () => {
  it('没有新版本时结束检查且不下载或安装', async () => {
    const f = fixture(); f.port.check.mockResolvedValue(null);
    expect(f.coordinator.status.kind).toBe('idle');
    await f.coordinator.check();
    expect(f.coordinator.status).toEqual({ kind: 'current' });
    expect(f.candidate.download).not.toHaveBeenCalled();
    expect(f.candidate.install).not.toHaveBeenCalled();
  });

  it('默认自动下载并保留累计进度，但从不自动安装', async () => {
    const f = fixture();
    f.candidate.download.mockImplementation(async progress => {
      progress({ downloadedBytes: 20, totalBytes: 80 });
      expect(f.coordinator.status).toMatchObject({ kind: 'downloading', downloadedBytes: 20, totalBytes: 80 });
    });
    await f.coordinator.check();
    expect(f.coordinator.status).toMatchObject({ kind: 'ready', version: f.candidate.version, body: f.candidate.body });
    expect(f.beforeInstall).not.toHaveBeenCalled();
    expect(f.candidate.install).not.toHaveBeenCalled();
  });

  it('关闭自动下载只报告新版本，重新启用后下载当前候选', async () => {
    const f = fixture(false);
    await f.coordinator.check();
    expect(f.coordinator.status.kind).toBe('available');
    expect(f.candidate.download).not.toHaveBeenCalled();
    f.coordinator.setAutoDownload(true);
    await f.coordinator.download();
    expect(f.candidate.download).toHaveBeenCalledTimes(1);
    expect(f.coordinator.status.kind).toBe('ready');
  });

  it('连续点击检查及其他操作只使用同一个未完成请求', async () => {
    const f = fixture(); const result = deferred<UpdateCandidate | null>();
    f.port.check.mockReturnValue(result.promise);
    const first = f.coordinator.check();
    expect(f.coordinator.check()).toBe(first);
    expect(f.coordinator.download()).toBe(first);
    expect(f.coordinator.install()).toBe(first);
    result.resolve(null); await first;
    expect(f.port.check).toHaveBeenCalledTimes(1);
  });

  it('网络失败可重新检查，不会将失败伪装为已是最新版本', async () => {
    const f = fixture(); f.port.check.mockRejectedValueOnce(new Error('HTTP 503'));
    await f.coordinator.check();
    expect(f.coordinator.status).toEqual({ kind: 'error', message: 'HTTP 503', retry: 'check' });
    await f.coordinator.retry();
    expect(f.port.check).toHaveBeenCalledTimes(2);
    expect(f.coordinator.status.kind).toBe('ready');
  });

  it.each(['连接中断', 'signature verification failed'])('下载失败可重试：%s', async message => {
    const f = fixture();
    f.candidate.download.mockImplementationOnce(async progress => {
      progress({ downloadedBytes: 80, totalBytes: 80 });
      throw new Error(message);
    });
    await f.coordinator.check();
    expect(f.coordinator.status).toMatchObject({ kind: 'error', message, retry: 'download' });
    expect(f.onStatus.mock.calls.some(([status]) => status.kind === 'ready')).toBe(false);
    await f.coordinator.install();
    expect(f.candidate.install).not.toHaveBeenCalled();
    await f.coordinator.retry();
    expect(f.coordinator.status.kind).toBe('ready');
    expect(f.candidate.download).toHaveBeenCalledTimes(2);
  });

  it('下载尚未结束时重复请求复用同一条下载链', async () => {
    const f = fixture(false); const result = deferred<void>();
    await f.coordinator.check();
    f.candidate.download.mockReturnValue(result.promise);
    const first = f.coordinator.download();
    expect(f.coordinator.download()).toBe(first);
    expect(f.coordinator.check()).toBe(first);
    result.resolve(); await first;
    expect(f.candidate.download).toHaveBeenCalledTimes(1);
  });

  it('上一次失败下载的迟到事件不能覆盖重试进度', async () => {
    const f = fixture(); const retry = deferred<void>();
    f.candidate.download.mockRejectedValueOnce(new Error('连接中断'));
    await f.coordinator.check();
    const staleProgress = f.candidate.download.mock.calls[0][0];
    f.candidate.download.mockImplementation(async progress => {
      progress({ downloadedBytes: 5, totalBytes: 50 }); await retry.promise;
    });
    const operation = f.coordinator.retry(); await Promise.resolve();
    staleProgress({ downloadedBytes: 90, totalBytes: 100 });
    expect(f.coordinator.status).toMatchObject({ kind: 'downloading', downloadedBytes: 5, totalBytes: 50 });
    retry.resolve(); await operation;
  });
});

describe('安装前保存与失败恢复', () => {
  it.each(['refused', 'throw'] as const)('保存未成功时保留安装包并禁止原生安装：%s', async outcome => {
    const f = fixture(); await f.coordinator.check();
    if (outcome === 'refused') f.beforeInstall.mockResolvedValueOnce(false);
    if (outcome === 'throw') f.beforeInstall.mockRejectedValueOnce(new Error('磁盘已锁定'));
    await f.coordinator.install();
    expect(f.coordinator.status).toMatchObject({ kind: 'error', retry: 'install' });
    expect(f.candidate.install).not.toHaveBeenCalled();
    expect(f.candidate.close).not.toHaveBeenCalled();
    expect(f.afterInstallFailure).toHaveBeenCalledTimes(1);
    await f.coordinator.retry();
    expect(f.candidate.install).toHaveBeenCalledTimes(1);
    expect(f.candidate.download).toHaveBeenCalledTimes(1);
    expect(f.beforeInstall).toHaveBeenCalledTimes(2);
  });

  it('保存尚未完成时不安装，重复点击只保存和安装一次', async () => {
    const f = fixture(); const saved = deferred<boolean>();
    await f.coordinator.check(); f.beforeInstall.mockReturnValue(saved.promise);
    const first = f.coordinator.install();
    expect(f.coordinator.install()).toBe(first);
    await Promise.resolve();
    expect(f.candidate.install).not.toHaveBeenCalled();
    saved.resolve(true); await first;
    expect(f.candidate.install).toHaveBeenCalledTimes(1);
    expect(f.beforeInstall).toHaveBeenCalledTimes(1);
    await f.coordinator.install();
    expect(f.candidate.install).toHaveBeenCalledTimes(1);
  });

  it('安装器失败后解除编辑锁，并再次保存后重试', async () => {
    const f = fixture(); await f.coordinator.check();
    f.candidate.install.mockRejectedValueOnce(new Error('安装器启动失败'));
    await f.coordinator.install();
    expect(f.coordinator.status).toMatchObject({ kind: 'error', message: '安装器启动失败', retry: 'install' });
    expect(f.afterInstallFailure).toHaveBeenCalledTimes(1);
    await f.coordinator.retry();
    expect(f.beforeInstall).toHaveBeenCalledTimes(2);
    expect(f.candidate.install).toHaveBeenCalledTimes(2);
  });

  it('重新检查不会丢弃已校验包或覆盖待安装状态', async () => {
    const f = fixture(); await f.coordinator.check();
    await f.coordinator.check();
    expect(f.port.check).toHaveBeenCalledTimes(1);
    expect(f.candidate.close).not.toHaveBeenCalled();
    expect(f.coordinator.status.kind).toBe('ready');
  });
});

describe('更新资源生命周期', () => {
  it('销毁后迟到的候选立即释放且不再下载或发布状态', async () => {
    const f = fixture(); const result = deferred<UpdateCandidate | null>(); const started = deferred<void>();
    f.port.check.mockImplementation(() => { started.resolve(); return result.promise; });
    const operation = f.coordinator.check();
    await started.promise;
    f.coordinator.dispose(); const count = f.onStatus.mock.calls.length;
    result.resolve(f.candidate); await operation;
    expect(f.candidate.close).toHaveBeenCalledTimes(1);
    expect(f.candidate.download).not.toHaveBeenCalled();
    expect(f.onStatus).toHaveBeenCalledTimes(count);
    await f.coordinator.check(); expect(f.port.check).toHaveBeenCalledTimes(1);
  });

  it('正在下载的资源等下载结束后释放，迟到进度不再通知', async () => {
    const f = fixture(false); const result = deferred<void>();
    await f.coordinator.check();
    f.candidate.download.mockReturnValue(result.promise);
    const operation = f.coordinator.download(); await Promise.resolve();
    f.coordinator.dispose(); f.coordinator.dispose();
    const count = f.onStatus.mock.calls.length;
    expect(f.candidate.close).not.toHaveBeenCalled();
    f.candidate.download.mock.calls[0][0]({ downloadedBytes: 10 });
    result.resolve(); await operation; await Promise.resolve();
    expect(f.candidate.close).toHaveBeenCalledTimes(1);
    expect(f.onStatus).toHaveBeenCalledTimes(count);
  });

  it('保存期间销毁后禁止安装并解除编辑锁', async () => {
    const f = fixture(); const saved = deferred<boolean>();
    await f.coordinator.check(); f.beforeInstall.mockReturnValue(saved.promise);
    const operation = f.coordinator.install(); await Promise.resolve();
    f.coordinator.dispose(); saved.resolve(true); await operation;
    expect(f.candidate.install).not.toHaveBeenCalled();
    expect(f.afterInstallFailure).toHaveBeenCalledTimes(1);
    expect(f.candidate.close).toHaveBeenCalledTimes(1);
  });

  it('重新检查时释放未下载的旧候选', async () => {
    const f = fixture(false); await f.coordinator.check();
    f.port.check.mockResolvedValue(null); await f.coordinator.check();
    expect(f.candidate.close).toHaveBeenCalledTimes(1);
    expect(f.coordinator.status).toEqual({ kind: 'current' });
  });
});
