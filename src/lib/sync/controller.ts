/** 连接生命周期与文档同步分离；连接或交换失败只更新同步状态，不阻止本地保存。 */
import { listen } from '@tauri-apps/api/event';
import type { ConnectionStatus, PairingOffer, SyncEnvelope, SyncTransport } from './contracts';
import { SyncEngine } from './engine';
import { errorMessage } from '../session/save-coordinator';
export class SyncController {
  connection: ConnectionStatus = { paired: false, listening: false };
  status = '未配对';
  error = '';
  busy = false;
  private dirty = false;
  private editGeneration = 0;
  private pendingOffer?: PairingOffer;
  private timer?: ReturnType<typeof setTimeout>;
  private dirtyTimer?: ReturnType<typeof setTimeout>;
  private idleRounds = 0;
  private stopListener?: () => void;
  private stopWakeListener?: () => void;
  private resyncRequested = false;
  private stopped = false;
  constructor(readonly engine: SyncEngine, readonly transport: SyncTransport, readonly desktop: boolean, private readonly changed: () => void) {}
  async start(): Promise<void> {
    await this.engine.load();
    this.stopListener = await listen<{ id: string; envelope: SyncEnvelope }>('foldmark:sync-request', async event => {
      try {
        if (this.stopped) throw new Error('应用正在关闭');
        const state = await this.transport.status();
        if (!state.paired || state.session !== this.connection.session) throw new Error('配对状态已变化');
        const generation = this.editGeneration;
        await this.engine.receive(event.payload.envelope);
        const reply = await this.engine.offer();
        await this.transport.respond(event.payload.id, reply);
        if (generation === this.editGeneration) this.dirty = false;
        this.status = this.summary(); this.error = '';
      } catch (error) { await this.transport.respond(event.payload.id, undefined, errorMessage(error)).catch(() => {}); this.error = errorMessage(error); }
      this.changed();
    });
    if (!this.desktop) this.stopWakeListener = await listen('foldmark:sync-wake', () => {
      if (this.busy) this.resyncRequested = true;
      else void this.sync();
    });
    if (this.stopped) { this.stopListener(); this.stopWakeListener?.(); return; }
    document.addEventListener('visibilitychange', this.visibility);
    await this.sync();
  }
  /** 变更通过长连接即时唤醒；空闲轮询仅补偿未触发输入事件的外部文件修改。 */
  private schedule(followUp = false): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const active = !this.desktop && !document.hidden && this.connection.paired && (!this.error || followUp);
    this.idleRounds = active ? 0 : this.idleRounds + 1;
    this.timer = setTimeout(() => { void this.sync(); }, active ? (this.dirty ? 400 : followUp ? 0 : 15000) : Math.min(15000, 5000 * 1.5 ** this.idleRounds));
  }
  private visibility = (): void => {
    if (!document.hidden) { void this.sync(); return; }
    if (!this.desktop) {
      clearTimeout(this.timer); clearTimeout(this.dirtyTimer);
      void this.transport.disconnect().catch(() => {});
    }
  };
  private summary(): string {
    const records = Object.values(this.engine.snapshot().records).filter(record => !record.binding || record.binding.enabled);
    if (records.some(record => record.conflict)) return '有同步冲突';
    if (records.some(record => record.error)) return '部分文档待处理';
    if (records.some(record => !record.binding)) return '有待接收文档';
    if (this.dirty) return '等待同步';
    if (records.some(record => record.binding?.enabled && record.binding.acknowledged !== record.document.head)) return '等待对端确认';
    return '已同步';
  }
  async pair(offer: PairingOffer): Promise<void> { this.pendingOffer = offer; await this.sync(); }
  async sync(): Promise<void> {
    if (this.stopped || !this.desktop && document.hidden) return;
    if (this.busy) { this.resyncRequested = true; return; }
    clearTimeout(this.timer); clearTimeout(this.dirtyTimer);
    this.resyncRequested = false;
    this.busy = true; this.changed();
    let followUp = false;
    try {
      if (this.pendingOffer) {
        if (await this.transport.pair(this.pendingOffer)) this.pendingOffer = undefined;
        else { this.status = '等待电脑确认'; return; }
      }
      this.connection = await this.transport.status();
      await this.engine.attachPairing(this.connection.session);
      if (!this.connection.paired) { this.status = '未配对'; return; }
      if (!this.desktop) {
        if (this.stopped || document.hidden) return;
        // 先建立或复用已认证连接再固化版本，离线重试不产生多余历史。
        await this.transport.probe();
        if (this.stopped || document.hidden) return;
        const generation = this.editGeneration;
        let outgoing = await this.engine.offer();
        if (this.stopped || document.hidden) return;
        let reply: SyncEnvelope;
        try { reply = await this.transport.exchange(outgoing); }
        catch (error) {
          if (!errorMessage(error).includes('SYNC_BASE_MISSING')) throw error;
          // 对端缺少增量基线（如应用数据重建）时用全量版本重试一次。
          outgoing = await this.engine.offer(true);
          if (this.stopped || document.hidden) return;
          reply = await this.transport.exchange(outgoing);
        }
        if (this.stopped) return;
        const current = await this.transport.status();
        if (current.session !== this.connection.session) return;
        await this.engine.receive(reply);
        // 本轮请求早于响应中的新版本；接收或合并后立即回传新 head，让电脑完成确认。
        // 只在 head 实际前进时跟进，未解决冲突和保存失败不能形成无间隔重试。
        const sent = new Map(outgoing.documents.map(doc => [doc.id, doc.head]));
        followUp = Object.values(this.engine.snapshot().records).some(record =>
          record.binding?.enabled && !record.conflict && !record.error && !record.pending && sent.get(record.document.id) !== record.document.head);
        // 网络等待期间的新输入尚未包含在本轮确认中，不能提前显示“已同步”。
        if (generation === this.editGeneration) this.dirty = false;
      } else await this.transport.notify();
      this.status = this.summary(); this.error = '';
    } catch (error) { this.error = errorMessage(error); this.status = '等待同步'; }
    finally { this.busy = false; this.schedule(followUp || this.resyncRequested); this.changed(); }
  }
  markDirty(localId?: string): void {
    if (!this.connection.paired || !Object.values(this.engine.snapshot().records).some(record => record.binding?.enabled && record.binding.localId === localId)) return;
    this.editGeneration++; this.dirty = true; this.status = '等待同步';
    // 输入后稍作合并再同步，避免连续按键每次都发起交换；增量传输下本轮只携带新版本。
    clearTimeout(this.timer);
    clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => { this.dirtyTimer = undefined; void this.sync(); }, 400);
    this.changed();
  }
  async unpair(): Promise<void> {
    this.pendingOffer = undefined;
    await this.transport.unpair(); await this.engine.reset();
    this.connection = await this.transport.status(); this.status = '未配对'; this.changed();
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.timer); clearTimeout(this.dirtyTimer);
    this.stopListener?.(); this.stopWakeListener?.(); document.removeEventListener('visibilitychange', this.visibility);
    void this.transport.disconnect().catch(() => {});
  }
}
