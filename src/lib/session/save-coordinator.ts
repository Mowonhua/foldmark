/**
 * 文件职责：协调单文档的自动保存、恢复快照和外部冲突。
 * 定义范围：保存状态、只读编辑器文本访问及文件端口调度。
 */
import type { FilePort, FileSnapshot } from '../contracts';

/** 结构职责：表示界面可解释的保存状态；冲突时保留最新磁盘快照供用户比较。 */
export interface SaveStatus { kind: 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'; message: string; external?: FileSnapshot }
/** 结构职责：绑定唯一编辑器文档与保存策略；reload 只在无本地修改或明确选用磁盘版本时调用。 */
export interface SaveOptions { files: FilePort; snapshot: FileSnapshot; getText: () => string; reload: (text: string) => void; onStatus: (status: SaveStatus) => void; delay?: number }
/**
 * 接口职责：按顺序保存最新文本并保护磁盘基线。
 * 调用方：每项目一个会话；非当前会话仍可完成保存。
 * 实现要求：不持有第二份可编辑文档；失败和冲突不得删除恢复数据。
 */
export class SaveCoordinator {
  private baseline: FileSnapshot;
  private timer?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private pending: Promise<boolean> | null = null;
  private recoveryQueue: Promise<void> = Promise.resolve();
  private conflict = false;
  private disposed = false;
  private externalGeneration = 0;
  private externalCheckPending = false;

  constructor(private readonly options: SaveOptions) { this.baseline = options.snapshot; }

  /** 编辑器只通知变化；延迟执行时读取最新正文，合并连续输入。 */
  changed(): void {
    if (this.disposed) return;
    clearTimeout(this.timer); clearTimeout(this.recoveryTimer);
    if (!this.conflict) this.options.onStatus({ kind: 'dirty', message: '未保存' });
    this.recoveryTimer = setTimeout(() => { void this.persistRecovery().catch(error => this.reportError(error)); }, 120);
    this.timer = setTimeout(() => { void this.flush(); }, this.options.delay ?? 600);
  }

  /** 同一个文档只有一条保存链；保存期间的新输入由循环继续提交。 */
  flush(): Promise<boolean> {
    clearTimeout(this.timer); clearTimeout(this.recoveryTimer);
    if (this.pending) return this.pending;
    // 开始保存即使旧读取失效，避免其稍后将新基线回退到旧磁盘内容。
    this.externalGeneration += 1;
    this.pending = this.saveLatest().finally(() => {
      this.pending = null;
      if (this.externalCheckPending && !this.disposed) {
        this.externalCheckPending = false; void this.checkExternal();
      }
    });
    return this.pending;
  }

  private async saveLatest(): Promise<boolean> {
    try {
      while (this.options.getText() !== this.baseline.text) {
        await this.persistRecovery();
        if (this.conflict) return false;
        const text = this.options.getText();
        this.options.onStatus({ kind: 'saving', message: '正在保存…' });
        this.baseline = await this.options.files.write(this.baseline.path, text, this.baseline.revision);
      }
      // 清除草稿也必须排在所有已提交的恢复写入之后，避免旧草稿复活。
      await this.recoveryQueue;
      await this.options.files.clearRecovery(this.baseline.path);
      if (this.options.getText() !== this.baseline.text) return this.saveLatest();
      this.options.onStatus({ kind: 'saved', message: '所有更改已保存' });
      return true;
    } catch (error) {
      if (errorMessage(error).includes('FILE_CONFLICT')) {
        this.conflict = true;
        try {
          const external = await this.options.files.read(this.baseline.path);
          this.options.onStatus({ kind: 'conflict', message: '文件在其他应用中已更改', external });
        } catch (readError) { this.reportError(readError); }
        return false;
      }
      this.reportError(error); return false;
    }
  }

  private persistRecovery(): Promise<void> {
    const draft = { path: this.baseline.path, text: this.options.getText(), baseRevision: this.baseline.revision, savedAt: Date.now() };
    this.recoveryQueue = this.recoveryQueue.catch(() => {}).then(() => this.options.files.saveRecovery(draft));
    return this.recoveryQueue;
  }

  /** 监听事件仅触发检查；真实写入仍必须独立校验磁盘基线。 */
  async checkExternal(): Promise<void> {
    if (this.disposed) return;
    if (this.pending) { this.externalCheckPending = true; return; }
    const generation = ++this.externalGeneration;
    const baseline = this.baseline;
    try {
      const external = await this.options.files.read(this.baseline.path);
      if (generation !== this.externalGeneration || this.pending || baseline !== this.baseline || this.disposed || external.revision === this.baseline.revision) return;
      if (this.options.getText() === this.baseline.text && !this.conflict) {
        this.baseline = external;
        this.options.reload(external.text);
        this.options.onStatus({ kind: 'saved', message: '已加载外部修改' });
        return;
      }
      this.conflict = true;
      await this.persistRecovery();
      this.options.onStatus({ kind: 'conflict', message: '文件在其他应用中已更改', external });
    } catch (error) { this.reportError(error); }
  }

  /** 用户选用磁盘版本时先保留本地恢复快照，再替换编辑器文本。 */
  async acceptExternal(snapshot: FileSnapshot): Promise<void> {
    clearTimeout(this.timer); clearTimeout(this.recoveryTimer);
    await this.persistRecovery();
    this.externalGeneration += 1;
    this.baseline = snapshot; this.conflict = false;
    this.options.reload(snapshot.text);
    this.options.onStatus({ kind: 'saved', message: '已选用磁盘版本；原草稿保留在恢复数据中' });
  }

  /** 明确保留本地时采用用户看到的外部基线，再次变更仍会触发冲突。 */
  async keepLocal(snapshot: FileSnapshot): Promise<boolean> {
    this.externalGeneration += 1;
    this.baseline = snapshot; this.conflict = false;
    return this.flush();
  }

  private reportError(error: unknown): void { this.options.onStatus({ kind: 'error', message: errorMessage(error) }); }
  dispose(): void { this.disposed = true; clearTimeout(this.timer); clearTimeout(this.recoveryTimer); }
}

/** 将结构化平台错误保留为可辨识的代码和文本，避免只显示 Object。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${'code' in error ? String(error.code) + ': ' : ''}${error.message}`;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return `${'code' in error ? String(error.code) + ': ' : ''}${String(error.message)}`;
  return String(error);
}
