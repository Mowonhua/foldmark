import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { SyncController } from './controller';
import type { SyncTransport } from './contracts';
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
const controllers: SyncController[] = [];
beforeEach(() => { vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); });
afterEach(() => { controllers.splice(0).forEach(controller => controller.stop()); vi.restoreAllMocks(); });
function fixture(desktop = false) {
  const read = vi.fn(async () => ({ text: '正文', name: '项目', archived: false }));
  const engine = new SyncEngine({ read, apply: async () => {}, accept: async () => 'local' }, { load: async () => null, save: async () => {} });
  const probe = vi.fn(async () => {});
  const transport: SyncTransport = {
    status: async () => ({ paired: true, session: 'paired-device', listening: desktop }), probe, exchange: async value => value,
    offer: async () => { throw new Error('此场景不发起配对'); }, pair: async () => true,
    approve: async () => {}, unpair: async () => {}, respond: async () => {}, address: async () => {},
  };
  const controller = new SyncController(engine, transport, desktop, () => {}); controllers.push(controller);
  return { controller, engine, read, probe, transport };
}
it('对端不可达时不为离线输入固化发送版本', async () => {
  const f = fixture(); await f.controller.start(); await f.engine.enable('local', 'project');
  const before = f.engine.snapshot(); f.read.mockClear(); f.probe.mockRejectedValue(new Error('offline'));
  await f.controller.sync(); expect(f.read).not.toHaveBeenCalled(); expect(f.engine.snapshot()).toEqual(before);
  expect(f.controller.status).toBe('等待同步');
});
it('原生权限拒绝保留可读原因，不显示对象占位文字', async () => {
  const f = fixture(); await f.controller.start();
  f.probe.mockRejectedValue({ message: '局域网权限已拒绝，请在系统设置中允许后重试' });
  await f.controller.sync();
  expect(f.controller.error).toBe('局域网权限已拒绝，请在系统设置中允许后重试');
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
