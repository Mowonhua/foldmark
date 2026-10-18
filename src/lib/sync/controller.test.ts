import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SyncEngine } from './engine';
import { SyncController } from './controller';
import type { DocumentContent, SyncTransport } from './contracts';
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void | Promise<void>>());
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, callback: (event: { payload: unknown }) => void | Promise<void>) => {
  listeners.set(name, callback); return () => { listeners.delete(name); };
} }));
const controllers: SyncController[] = [];
beforeEach(() => { vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); });
afterEach(() => { controllers.splice(0).forEach(controller => controller.stop()); vi.restoreAllMocks(); });
function fixture(desktop = false) {
  const read = vi.fn(async () => ({ text: '正文', name: '项目', archived: false }));
  const apply = vi.fn(async (_id: string, _expected: DocumentContent, _next: DocumentContent) => {});
  const engine = new SyncEngine({ read, apply, accept: async () => 'local' }, { load: async () => null, save: async () => {} });
  const probe = vi.fn(async () => {});
  const transport: SyncTransport = {
    status: async () => ({ paired: true, session: 'paired-device', listening: desktop }), probe, exchange: async value => value,
    offer: async () => { throw new Error('此场景不发起配对'); }, pair: async () => true,
    approve: async () => {}, unpair: async () => {}, respond: async () => {}, address: async () => {},
    notify: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
  };
  const controller = new SyncController(engine, transport, desktop, () => {}); controllers.push(controller);
  return { controller, engine, read, apply, probe, transport };
}
it('对端不可达时不为离线输入固化发送版本', async () => {
  const f = fixture(); await f.controller.start(); await f.engine.enable('local', 'project');
  const before = f.engine.snapshot(); f.read.mockClear(); f.probe.mockRejectedValue(new Error('offline'));
  await f.controller.sync(); expect(f.read).not.toHaveBeenCalled(); expect(f.engine.snapshot()).toEqual(before);
  // 对端没开只改变面板状态，底栏不提示；本机正文已保存在磁盘上，重试即恢复。
  expect(f.controller.status).toBe('等待对端'); expect(f.controller.attention).toBe('');
});
it('原生权限拒绝保留可读原因，不显示对象占位文字', async () => {
  const f = fixture(); await f.controller.start();
  f.probe.mockRejectedValue({ message: '局域网权限已拒绝，请在系统设置中允许后重试' });
  await f.controller.sync();
  expect(f.controller.error).toBe('局域网权限已拒绝，请在系统设置中允许后重试');
  expect(f.controller.status).toBe('同步失败'); expect(f.controller.attention).toBe('同步失败');
});
it('已配对且确认完成时底栏不呈现同步状态', async () => {
  const f = fixture(); await f.controller.start(); await f.engine.enable('local', 'project');
  await f.controller.sync();
  expect(f.controller.status).toBe('已同步'); expect(f.controller.attention).toBe('');
});
it('手机离开前台不启动连接，前台确认后显示已同步', async () => {
  const f = fixture(); await f.controller.start(); await f.engine.enable('local', 'project');
  f.probe.mockClear(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await f.controller.sync(); expect(f.probe).not.toHaveBeenCalled();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await f.controller.sync(); expect(f.controller.status).toBe('已同步');
});
it('桌面等待手机请求，不持续生成离线历史或改变未选择文档的状态', async () => {
  const f = fixture(true); await f.controller.start(); await f.engine.enable('local', 'project'); f.read.mockClear();
  f.controller.markDirty('other'); expect(f.controller.status).toBe('已同步');
  f.controller.markDirty('local'); await f.controller.sync();
  expect(f.controller.status).toBe('等待同步'); expect(f.read).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
});
it('传输等待期间的新输入不能被旧版本确认清除', async () => {
  const f = fixture(); await f.controller.start(); await f.engine.enable('local', 'project');
  f.transport.exchange = async value => { f.controller.markDirty('local'); return value; };
  await f.controller.sync(); expect(f.controller.status).toBe('等待同步');
  f.transport.exchange = async value => value;
  await f.controller.sync(); expect(f.controller.status).toBe('已同步');
});
it('输入后防抖自动同步，不等待轮询', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); await f.controller.start(); await f.engine.enable('local', 'project');
    const exchange = vi.spyOn(f.transport, 'exchange'); exchange.mockClear();
    f.controller.markDirty('local');
    await vi.advanceTimersByTimeAsync(399); expect(exchange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(exchange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999); expect(exchange).toHaveBeenCalledTimes(1);
    f.controller.markDirty('local'); f.controller.markDirty('local');
    await vi.advanceTimersByTimeAsync(400); expect(exchange).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it('长连接空闲仅兜底轮询，离线逐步退避且新输入快速跟进', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); await f.controller.start(); await f.engine.enable('local', 'project');
    const exchange = vi.spyOn(f.transport, 'exchange'); exchange.mockClear();
    await vi.advanceTimersByTimeAsync(14999); expect(exchange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(exchange).toHaveBeenCalledTimes(1);
    // 传输中产生的新输入保持 dirty，下一轮由防抖跟上。
    exchange.mockImplementation(async value => { f.controller.markDirty('local'); return value; });
    await vi.advanceTimersByTimeAsync(14999); expect(exchange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(exchange).toHaveBeenCalledTimes(2);
    exchange.mockImplementation(async value => value);
    await vi.advanceTimersByTimeAsync(399); expect(exchange).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(exchange).toHaveBeenCalledTimes(3);
    f.probe.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(15000);
    const probes = f.probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(7499); expect(f.probe).toHaveBeenCalledTimes(probes);
    await vi.advanceTimersByTimeAsync(1); expect(f.probe).toHaveBeenCalledTimes(probes + 1);
    await vi.advanceTimersByTimeAsync(11249); expect(f.probe).toHaveBeenCalledTimes(probes + 1);
    await vi.advanceTimersByTimeAsync(1); expect(f.probe).toHaveBeenCalledTimes(probes + 2);
  } finally { vi.useRealTimers(); }
});
it('对端缺少增量基线时用全量版本重试一次', async () => {
  const f = fixture(); await f.controller.start(); await f.engine.enable('local', 'project');
  const offer = vi.spyOn(f.engine, 'offer');
  let failed = false;
  f.transport.exchange = async value => { if (!failed) { failed = true; throw new Error('SYNC_BASE_MISSING: 对端引用了本机没有的版本'); } return value; };
  await f.controller.sync();
  expect(offer.mock.calls).toEqual([[], [true]]); expect(f.controller.status).toBe('已同步');
});

it('前台空闲后电脑通知立即送达手机并完成双方确认', async () => {
  vi.useFakeTimers();
  try {
    // 固定虚拟时钟中的哈希完成顺序，避免原生线程池跨越计时断言。
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, data) =>
      Uint8Array.from(createHash('sha256').update(data as Uint8Array).digest()).buffer);
    const f = fixture();
    let desktopText = '正文'; let phoneText = '正文';
    f.read.mockImplementation(async () => ({ text: phoneText, name: '项目', archived: false }));
    const desktop = new SyncEngine({
      read: async () => ({ text: desktopText, name: '项目', archived: false }),
      apply: async (_id, _expected, next) => { desktopText = next.text; }, accept: async () => 'desktop',
    }, { load: async () => null, save: async () => {} });
    await desktop.load();
    const id = await desktop.enable('desktop', 'project');
    f.transport.exchange = async offer => { await desktop.receive(offer); return desktop.offer(); };
    // 使用真实接收写入，不能用回显请求代替两端版本交换。
    f.apply.mockImplementation(async (_id, _expected, next) => { phoneText = next.text; });
    await f.controller.start(); await f.engine.accept(id);
    await f.controller.sync(); await f.controller.sync();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.controller.error).toBe('');
    desktopText = '电脑编辑';
    await listeners.get('foldmark:sync-wake')?.({ payload: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(phoneText).toBe('电脑编辑');
    await vi.advanceTimersByTimeAsync(1);
    const record = desktop.snapshot().records[id];
    expect(record.binding?.acknowledged).toBe(record.document.head);
    expect(f.controller.status).toBe('已同步');
  } finally { vi.useRealTimers(); }
});

it('电脑输入防抖后主动通知长连接，手机进入后台释放连接', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(true); await f.controller.start(); await f.engine.enable('local', 'project');
    vi.mocked(f.transport.notify).mockClear();
    f.controller.markDirty('local');
    await vi.advanceTimersByTimeAsync(400);
    expect(f.transport.notify).toHaveBeenCalledTimes(1);
    const phone = fixture(); await phone.controller.start();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(phone.transport.disconnect).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it('传输占用超过输入防抖时，完成后四百毫秒内发送新输入', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); await f.controller.start(); await f.engine.enable('local', 'project');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const exchange = vi.spyOn(f.transport, 'exchange').mockImplementationOnce(async value => { await blocked; return value; });
    const running = f.controller.sync();
    await vi.advanceTimersByTimeAsync(0); expect(exchange).toHaveBeenCalledTimes(1);
    f.controller.markDirty('local');
    await vi.advanceTimersByTimeAsync(500);
    release(); await running;
    expect(f.controller.status).toBe('等待同步');
    await vi.advanceTimersByTimeAsync(399); expect(exchange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(exchange).toHaveBeenCalledTimes(2);
    expect(f.controller.status).toBe('已同步');
  } finally { vi.useRealTimers(); }
});

it('交换过程中收到电脑通知，结束后立即跟进且不重复轮询', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); await f.controller.start();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const exchange = vi.spyOn(f.transport, 'exchange').mockImplementationOnce(async value => { await blocked; return value; });
    const running = f.controller.sync(); await vi.advanceTimersByTimeAsync(0);
    await listeners.get('foldmark:sync-wake')?.({ payload: null });
    release(); await running; await vi.advanceTimersByTimeAsync(1);
    expect(exchange).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); expect(exchange).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it('读取连接状态期间退到后台不再建连', async () => {
  const f = fixture(); await f.controller.start();
  const exchange = vi.spyOn(f.transport, 'exchange'); f.probe.mockClear();
  f.transport.status = async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    return { paired: true, session: 'paired-device', listening: false };
  };
  await f.controller.sync();
  expect(f.probe).not.toHaveBeenCalled(); expect(exchange).not.toHaveBeenCalled();
});
