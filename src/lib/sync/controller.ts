/** 连接生命周期与文档同步分离；前台轮询失败只更新同步状态，不阻止本地保存。 */
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
  private timer?: ReturnType<typeof setInterval>;
  private stopListener?: () => void;
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
    if (this.stopped) { this.stopListener(); return; }
    this.timer = setInterval(() => { void this.sync(); }, 5000);
    document.addEventListener('visibilitychange', this.visibility);
    await this.sync();
  }
  private visibility = (): void => { if (!document.hidden) void this.sync(); };
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
    if (this.busy || this.stopped || !this.desktop && document.hidden) return;
    this.busy = true; this.changed();
    try {
      if (this.pendingOffer) {
        if (await this.transport.pair(this.pendingOffer)) this.pendingOffer = undefined;
        else { this.status = '等待电脑确认'; return; }
      }
      this.connection = await this.transport.status();
      await this.engine.attachPairing(this.connection.session);
      if (!this.connection.paired) { this.status = '未配对'; return; }
      if (!this.desktop) {
        // 先确认对端可达再固化发送版本，离线输入不应每五秒产生一份完整历史。
        await this.transport.probe();
        const generation = this.editGeneration;
        const offer = await this.engine.offer();
        const reply = await this.transport.exchange(offer);
        if (this.stopped) return;
        const current = await this.transport.status();
        if (current.session !== this.connection.session) return;
        await this.engine.receive(reply);
        // 网络等待期间的新输入尚未包含在本轮确认中，不能提前显示“已同步”。
        if (generation === this.editGeneration) this.dirty = false;
      }
      this.status = this.summary(); this.error = '';
    } catch (error) { this.error = errorMessage(error); this.status = '等待同步'; }
    finally { this.busy = false; this.changed(); }
  }
  markDirty(localId?: string): void {
    if (!this.connection.paired || !Object.values(this.engine.snapshot().records).some(record => record.binding?.enabled && record.binding.localId === localId)) return;
    this.editGeneration++; this.dirty = true; this.status = '等待同步'; this.changed();
  }
  async unpair(): Promise<void> {
    this.pendingOffer = undefined;
    await this.transport.unpair(); await this.engine.reset();
    this.connection = await this.transport.status(); this.status = '未配对'; this.changed();
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); this.stopListener?.(); document.removeEventListener('visibilitychange', this.visibility); }
}
