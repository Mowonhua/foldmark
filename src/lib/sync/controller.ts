/** 连接生命周期与文档同步分离；连接或交换失败只更新同步状态，不阻止本地保存。 */
import { listen } from '@tauri-apps/api/event';
import type { ConnectionStatus, PairingOffer, SyncEnvelope, SyncTransport } from './contracts';
import { SyncEngine } from './engine';
import { errorMessage } from '../session/save-coordinator';
/**
 * 需要用户处理的同步错误：配对失效、协议不兼容、超出限制、本机保存失败和本机网络配置错误。
 * 连接被拒、超时和断线只表示对端暂时不可达，重试即可，不进入底栏提示。
 */
const actionable = (message: string): boolean => /^(SYNC_AUTH|SYNC_PROTOCOL|SYNC_LIMIT|SYNC_SAVE):|^局域网权限|^仅支持局域网|^请输入局域网/.test(message);
export class SyncController {
  connection: ConnectionStatus = { paired: false, listening: false };
  status = '未配对';
  /** 底栏需要呈现的问题；空串表示底栏不出现同步入口，正常同步过程只留在同步面板。 */
  attention = '';
  error = '';
  busy = false;
  private dirty = false;
  /** 最近一次交换未能联系到对端；正文已保存在本机，重试即可恢复，不算同步失败。 */
  private offline = false;
  private editGeneration = 0;
  private pendingOffer?: PairingOffer;
  private timer?: ReturnType<typeof setTimeout>;
  private dirtyTimer?: ReturnType<typeof setTimeout>;
  private idleRounds = 0;
  private stopListener?: () => void;
  private stopWakeListener?: () => void;
  private stopPairListener?: () => void;
  private resyncRequested = false;
  /** 手机已提交配对、等待电脑允许；此状态按短间隔复查，不能套用离线退避。 */
  private awaitingApproval = false;
  private stopped = false;
  constructor(readonly engine: SyncEngine, readonly transport: SyncTransport, readonly desktop: boolean, private readonly changed: () => void) {}
  async start(): Promise<void> {
    await this.engine.load();
    this.stopListener = await listen<{ id: string; envelope: SyncEnvelope }>('taskrail:sync-request', async event => {
      try {
        if (this.stopped) throw new Error('应用正在关闭');
        const state = await this.transport.status();
        if (!state.paired || state.session !== this.connection.session) throw new Error('配对状态已变化');
        const generation = this.editGeneration;
        await this.engine.receive(event.payload.envelope);
        const reply = await this.engine.offer();
        await this.transport.respond(event.payload.id, reply);
        if (generation === this.editGeneration && !this.engine.deferred) this.dirty = false;
        this.offline = false; this.error = ''; this.setStatus(this.summary());
      } catch (error) {
        this.error = errorMessage(error); this.offline = !actionable(this.error);
        await this.transport.respond(event.payload.id, undefined, this.error).catch(() => {});
        this.setStatus(this.offline ? this.summary() : '同步失败');
      }
      this.changed();
    });
    if (!this.desktop) this.stopWakeListener = await listen('taskrail:sync-wake', () => {
      if (this.busy) this.resyncRequested = true;
      else void this.sync();
    });
    // 配对请求写在原生端，轮询间隔会退避到十五秒；收到请求立即刷新，确认按钮才能马上出现。
    if (this.desktop) this.stopPairListener = await listen('taskrail:sync-pair-request', () => this.sync());
    if (this.stopped) { this.stopListener(); this.stopWakeListener?.(); this.stopPairListener?.(); return; }
    document.addEventListener('visibilitychange', this.visibility);
    await this.sync();
  }
  /** 变更通过长连接即时唤醒；空闲轮询仅补偿未触发输入事件的外部文件修改。 */
  private schedule(followUp = false): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const active = !this.desktop && !document.hidden && this.connection.paired && (!this.error || followUp);
    this.idleRounds = active ? 0 : this.idleRounds + 1;
    // 手机已发出配对请求时电脑可能已允许连接，一秒复查一次；离线失败仍按退避重试。
    const awaiting = !this.desktop && !document.hidden && this.awaitingApproval;
    const delay = awaiting ? 1000 : active ? (this.dirty ? 400 : followUp ? 0 : 15000) : Math.min(15000, 5000 * 1.5 ** this.idleRounds);
    this.timer = setTimeout(() => { void this.sync(); }, delay);
  }
  private visibility = (): void => {
    if (!document.hidden) { void this.sync(); return; }
    if (!this.desktop) {
      clearTimeout(this.timer); clearTimeout(this.dirtyTimer);
      void this.transport.disconnect().catch(() => {});
    }
  };
  /** 面板设备行展示的同步状态；底栏不读取这里，改由 issues() 判断是否需要用户处理。 */
  private summary(): string {
    const records = Object.values(this.engine.snapshot().records).filter(record => !record.binding || record.binding.enabled);
    if (records.some(record => record.conflict)) return '有同步冲突';
    if (records.some(record => record.error && !record.error.includes('SYNC_ASSET_PENDING'))) return '部分文档待处理';
    if (this.engine.pendingAssets) return '正在同步图片';
    if (records.some(record => !record.binding)) return '有待接收文档';
    // 对端没开时本机改动仍保存在磁盘上，重试即可，不能显示成同步失败。
    if (this.offline) return '等待对端';
    // 本机仍在输入或编辑画布，文档尚未进入本轮交换；交互结束后补发。
    if (this.dirty || this.engine.deferred) return '等待同步';
    if (records.some(record => record.binding?.enabled && record.binding.acknowledged !== record.document.head)) return '等待对端确认';
    return '已同步';
  }
  /** 底栏只列需要用户处理的问题；未配对、待发送、待确认和对端离线都只留在同步面板。 */
  private issues(): string {
    if (!this.connection.paired) return '';
    const records = Object.values(this.engine.snapshot().records).filter(record => !record.binding || record.binding.enabled);
    if (records.some(record => record.conflict)) return '有同步冲突';
    if (records.some(record => !record.binding)) return '有文档待接收';
    if (records.some(record => record.error && !record.error.includes('SYNC_ASSET_PENDING'))) return '同步失败';
    return this.offline ? '' : this.error ? '同步失败' : '';
  }
  /** 状态与底栏提示一起更新，避免两处各自推断同一批记录。 */
  private setStatus(status: string): void {
    this.status = status;
    this.attention = this.issues();
  }
  /** 本机还有未发送给对端的修改；面板用它区分“确认已完成”和“确认后本机又改过”。 */
  get pendingEdits(): boolean { return this.dirty; }
  async pair(offer: PairingOffer): Promise<void> { this.pendingOffer = offer; this.awaitingApproval = false; await this.sync(); }
  async sync(): Promise<void> {
    if (this.stopped || !this.desktop && document.hidden) return;
    if (this.busy) { this.resyncRequested = true; return; }
    clearTimeout(this.timer); clearTimeout(this.dirtyTimer);
    this.resyncRequested = false;
    this.busy = true; this.changed();
    let followUp = false;
    try {
      if (this.pendingOffer) {
        if (await this.transport.pair(this.pendingOffer)) { this.pendingOffer = undefined; this.awaitingApproval = false; }
        else { this.awaitingApproval = true; this.setStatus('等待电脑确认'); return; }
      }
      this.connection = await this.transport.status();
      await this.engine.attachPairing(this.connection.session);
      if (!this.connection.paired) { this.offline = false; this.error = ''; this.setStatus('未配对'); return; }
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
        followUp = this.engine.pendingAssets || Object.values(this.engine.snapshot().records).some(record =>
          record.binding?.enabled && !record.conflict && !record.error && !record.pending && sent.get(record.document.id) !== record.document.head);
        // 网络等待期间的新输入尚未包含在本轮确认中，不能提前显示“已同步”。
        if (generation === this.editGeneration && !this.engine.deferred) this.dirty = false;
      } else await this.transport.notify();
      this.offline = false; this.error = ''; this.setStatus(this.summary());
    } catch (error) {
      // 建连或配对失败不属于等待确认，恢复正常退避，避免持续高频重试。
      this.awaitingApproval = false;
      const message = errorMessage(error);
      // 连不上对端属于预期状态：本机正文已保存，只有本机能处理的错误才提示同步失败。
      this.offline = !actionable(message); this.error = message;
      this.setStatus(this.offline ? this.summary() : '同步失败');
    } finally { this.busy = false; this.schedule(followUp || this.resyncRequested); this.changed(); }
  }
  markDirty(localId?: string): void {
    if (!this.connection.paired || !Object.values(this.engine.snapshot().records).some(record => record.binding?.enabled && record.binding.localId === localId)) return;
    this.editGeneration++; this.dirty = true; this.setStatus(this.summary());
    // 输入后稍作合并再同步，避免连续按键每次都发起交换；增量传输下本轮只携带新版本。
    clearTimeout(this.timer);
    clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => { this.dirtyTimer = undefined; void this.sync(); }, 400);
    this.changed();
  }
  async unpair(): Promise<void> {
    this.pendingOffer = undefined;
    this.awaitingApproval = false;
    await this.transport.unpair(); await this.engine.reset();
    this.connection = await this.transport.status(); this.offline = false; this.error = ''; this.setStatus('未配对'); this.changed();
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.timer); clearTimeout(this.dirtyTimer);
    this.stopListener?.(); this.stopWakeListener?.(); this.stopPairListener?.(); document.removeEventListener('visibilitychange', this.visibility);
    void this.transport.disconnect().catch(() => {});
  }
}
