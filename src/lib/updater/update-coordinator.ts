/**
 * 文件职责：协调更新检查、后台下载和保存后的用户安装请求。
 * 定义范围：更新状态机、并发去重及原生候选资源生命周期。
 */
import { translate } from '../i18n';
import type { UpdateCandidate, UpdateOptions, UpdateStatus } from './contracts';
import { errorMessage } from '../session/save-coordinator';

// ==================== 更新策略 ====================

/**
 * 接口职责：用单个操作序列协调更新并保护应用保存边界。
 * 调用方：App 在挂载时调用 check，在设置及更新通知中调用其余公开方法。
 * 实现要求：不主动安装；并发操作复用当前 Promise；销毁后不再发布状态或开始安装。
 */
export class UpdateCoordinator {
  private snapshot: UpdateStatus = { kind: 'idle' };
  private candidate: UpdateCandidate | null = null;
  private downloaded = false;
  private autoDownload: boolean;
  private disposed = false;
  private pending: Promise<void> | null = null;

  constructor(private readonly options: UpdateOptions) { this.autoDownload = options.autoDownload ?? true; }

  /**
   * 函数职责：取得当前状态快照。
   * 输入说明：无需输入。
   * 输出说明：返回只读状态，调用方不能据此取得原生候选资源。
   * 实现思路：读取协调器最近发布的状态。
   */
  get status(): Readonly<UpdateStatus> { return this.snapshot; }

  /**
   * 函数职责：检查新版本并按当前设置自动下载。
   * 输入说明：由启动流程或用户手动触发。
   * 输出说明：失败进入可重试状态；已有完整安装包时保留该包。
   * 实现思路：串行释放旧候选、执行检查和可选下载，共享未完成操作。
   */
  check(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.disposed || this.downloaded) return Promise.resolve();
    return this.run(() => this.checkLatest());
  }

  /**
   * 函数职责：下载当前候选并等待签名校验。
   * 输入说明：仅在存在候选且尚未下载完成时生效。
   * 输出说明：成功进入 ready；失败保留候选并允许重试下载。
   * 实现思路：累积进度快照，使用平台 Promise 的完成结果判断可安装性。
   */
  download(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.disposed || !this.candidate || this.downloaded) return Promise.resolve();
    return this.run(() => this.downloadCandidate());
  }

  /**
   * 函数职责：响应用户操作，保存全部数据后安装更新。
   * 输入说明：必须已有下载并校验成功的安装包。
   * 输出说明：保存或安装失败允许重试；保存拒绝时禁止原生安装。
   * 实现思路：先调用应用保存边界，再调用候选安装，失败时解除应用锁定。
   */
  install(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.disposed || !this.candidate || !this.downloaded || this.snapshot.kind === 'installing') return Promise.resolve();
    return this.run(() => this.installCandidate());
  }

  /**
   * 函数职责：重新执行当前错误对应的安全恢复操作。
   * 输入说明：只读取当前状态的 retry 字段。
   * 输出说明：遵循原操作的并发、下载及保存约束。
   * 实现思路：转发到对应的公开操作入口。
   */
  retry(): Promise<void> {
    if (this.snapshot.retry === 'check') return this.check();
    if (this.snapshot.retry === 'download') return this.download();
    if (this.snapshot.retry === 'install') return this.install();
    return this.pending ?? Promise.resolve();
  }

  /**
   * 函数职责：更新后台下载偏好。
   * 输入说明：enabled 来自已持久化的用户设置。
   * 输出说明：启用时可下载当前已发现版本；关闭不会取消已经启动的下载。
   * 实现思路：更新偏好，只对 available 状态启动下载。
   */
  setAutoDownload(enabled: boolean): void {
    this.autoDownload = enabled;
    if (enabled && this.snapshot.kind === 'available') void this.download();
  }

  /**
   * 函数职责：停止状态通知并释放当前和迟到的原生资源。
   * 输入说明：由拥有协调器的应用卸载流程调用，可重复调用。
   * 输出说明：正在使用的资源等操作结束后关闭，迟到的检查结果立即关闭。
   * 实现思路：标记失效并在资源不再被未完成操作使用时执行一次释放。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 下载 Promise 完成前，插件尚未挂接字节资源，提前 close 会漏掉迟到的下载包。
    if (!this.pending) void this.closeCandidate();
  }

  /** 先占有操作锁再进入回调，onStatus 同步重入也只能复用同一 Promise。 */
  private run(operation: () => Promise<void>): Promise<void> {
    this.pending = Promise.resolve().then(async () => {
      if (!this.disposed) await operation();
    }).finally(async () => {
      if (this.disposed) await this.closeCandidate();
      this.pending = null;
    });
    return this.pending;
  }

  private async checkLatest(): Promise<void> {
    this.publish({ kind: 'checking' });
    try {
      await this.closeCandidate();
      if (this.disposed) return;
      const candidate = await this.options.port.check();
      if (this.disposed) { await this.release(candidate); return; }
      this.candidate = candidate;
      if (!candidate) { this.publish({ kind: 'current' }); return; }
      this.publish({ kind: 'available' });
      if (this.autoDownload && !this.disposed) await this.downloadCandidate();
    } catch (error) { this.publish({ kind: 'error', message: errorMessage(error), retry: 'check' }); }
  }

  private async downloadCandidate(): Promise<void> {
    const candidate = this.candidate;
    if (!candidate || this.disposed) return;
    this.publish({ kind: 'downloading', downloadedBytes: 0 });
    if (this.disposed) return;
    let active = true;
    try {
      await candidate.download(progress => {
        // IPC 事件可能晚于请求失败；上一轮回调不能覆盖新一轮下载的进度。
        if (active) this.publish({ kind: 'downloading', ...progress });
      });
      if (this.disposed) return;
      this.downloaded = true;
      this.publish({ kind: 'ready' });
    } catch (error) { this.publish({ kind: 'error', message: errorMessage(error), retry: 'download' }); }
    finally { active = false; }
  }

  private async installCandidate(): Promise<void> {
    const candidate = this.candidate;
    if (!candidate || this.disposed) return;
    this.publish({ kind: 'installing' });
    if (this.disposed) return;
    try {
      const saved = await this.options.beforeInstall();
      if (!saved) throw new Error(translate('请先解决未保存的更改或文件冲突，再重试安装更新。'));
      if (this.disposed) { this.options.afterInstallFailure?.(); return; }
      // Windows 原生安装成功后直接退出；所有会话和配置必须在此前完成保存。
      await candidate.install();
    } catch (error) {
      this.options.afterInstallFailure?.();
      this.publish({ kind: 'error', message: errorMessage(error), retry: 'install' });
    }
  }

  /** 每次只发布当前阶段字段，防止上一轮错误或进度残留到新的检查。 */
  private publish(status: UpdateStatus): void {
    if (this.disposed) return;
    const candidate = this.candidate;
    this.snapshot = candidate && status.kind !== 'checking'
      ? { version: candidate.version, currentVersion: candidate.currentVersion, body: candidate.body, ...status }
      : status;
    this.options.onStatus(this.snapshot);
  }

  private async closeCandidate(): Promise<void> {
    const candidate = this.candidate;
    this.candidate = null;
    this.downloaded = false;
    await this.release(candidate);
  }

  /** 释放失败不覆盖用户正在处理的下载或保存错误；进程退出仍会回收原生资源表。 */
  private async release(candidate: UpdateCandidate | null): Promise<void> {
    try { await candidate?.close(); } catch { /* 资源清理不参与更新状态机。 */ }
  }
}
