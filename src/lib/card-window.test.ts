/** 文件职责：验证卡片窗口的几何恢复、串行切换与故障回滚。 */
import { describe, expect, it, vi } from 'vitest';
import { currentMonitor, LogicalSize, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import { createCardWindowController } from './card-window';

vi.mock('@tauri-apps/api/window', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/window')>(),
  currentMonitor: vi.fn(async () => null),
}));

function fakeWindow(maximized = false, fullscreen = false, alwaysOnTop = false) {
  const normalSize = new PhysicalSize(1100, 750);
  const normalPosition = new PhysicalPosition(160, 90);
  const state = { maximized, fullscreen, alwaysOnTop, size: normalSize, position: normalPosition };
  const calls: string[] = [];
  const window = {
    scaleFactor: vi.fn(async () => 1),
    innerSize: vi.fn(async () => state.maximized || state.fullscreen ? new PhysicalSize(1920, 1080) : state.size),
    outerPosition: vi.fn(async () => state.maximized || state.fullscreen ? new PhysicalPosition(0, 0) : state.position),
    isMaximized: vi.fn(async () => state.maximized),
    isFullscreen: vi.fn(async () => state.fullscreen),
    isAlwaysOnTop: vi.fn(async () => state.alwaysOnTop),
    setSize: vi.fn(async (size: LogicalSize | PhysicalSize) => { calls.push('size'); state.size = new PhysicalSize(size.width, size.height); }),
    setPosition: vi.fn(async (position: PhysicalPosition) => { calls.push('position'); state.position = position; }),
    setMinSize: vi.fn(async (_size: LogicalSize) => { calls.push('min'); }),
    setAlwaysOnTop: vi.fn(async (value: boolean) => { calls.push('top'); state.alwaysOnTop = value; }),
    setFullscreen: vi.fn(async (value: boolean) => { calls.push(value ? 'fullscreen' : 'unfullscreen'); state.fullscreen = value; }),
    maximize: vi.fn(async () => { calls.push('maximize'); state.maximized = true; }),
    unmaximize: vi.fn(async () => { calls.push('unmaximize'); state.maximized = false; }),
  };
  return { window, state, calls, normalSize, normalPosition };
}

describe('卡片窗口', () => {
  it('动画使用物理像素缓出插值，最终准确到达高 DPI 卡片几何', async () => {
    const { window, state } = fakeWindow();
    window.scaleFactor.mockResolvedValue(2);
    let time = 0;
    const clock = { now: () => time, nextFrame: vi.fn(async () => time += 100) };
    const controller = createCardWindowController(window, async () => null, clock);
    await controller.enter({ animate: true });
    expect(window.setSize.mock.calls.map(([size]) => [size.width, size.height])).toEqual([[803, 1074], [760, 1120]]);
    expect(window.setSize.mock.calls.every(([size]) => size instanceof PhysicalSize)).toBe(true);
    expect(state.size).toEqual(new PhysicalSize(760, 1120));
    expect(clock.nextFrame).toHaveBeenCalledTimes(2);
  });

  it('退出动画放大完成后才恢复普通最小尺寸，原始几何准确还原', async () => {
    const { window, state, calls, normalSize, normalPosition } = fakeWindow();
    let time = 0;
    const clock = { now: () => time, nextFrame: async () => time += 100 };
    const controller = createCardWindowController(window, async () => null, clock);
    await controller.enter();
    await window.setPosition(new PhysicalPosition(600, 300));
    calls.length = 0;
    await controller.exit({ animate: true });
    expect(state.size).toEqual(normalSize);
    expect(state.position).toEqual(normalPosition);
    expect(calls.lastIndexOf('size')).toBeLessThan(calls.indexOf('min'));
    expect(calls.lastIndexOf('position')).toBeLessThan(calls.indexOf('min'));
  });

  it('减少动态效果直接切换且完全不调用帧时钟', async () => {
    const { window } = fakeWindow();
    const clock = { now: vi.fn(), nextFrame: vi.fn() };
    const controller = createCardWindowController(window, async () => null, clock);
    await controller.enter({ animate: false });
    await controller.exit({ animate: false });
    expect(clock.now).not.toHaveBeenCalled();
    expect(clock.nextFrame).not.toHaveBeenCalled();
    expect(window.setSize).toHaveBeenCalledTimes(2);
  });

  it('动画中途原生调用失败立即回滚且不会调度剩余帧', async () => {
    const { window, state, normalSize } = fakeWindow();
    let time = 0;
    const clock = { now: () => time, nextFrame: vi.fn(async () => time += 50) };
    window.setSize.mockRejectedValueOnce(new Error('frame failed'));
    const controller = createCardWindowController(window, async () => null, clock);
    await expect(controller.enter({ animate: true })).rejects.toThrow('frame failed');
    expect(state.size).toEqual(normalSize);
    expect(state.alwaysOnTop).toBe(false);
    expect(clock.nextFrame).toHaveBeenCalledTimes(1);
    await controller.enter();
    expect(state.alwaysOnTop).toBe(true);
  });

  it('上一帧原生尺寸调用未完成时不会调度或写入后续帧', async () => {
    const { window } = fakeWindow();
    let time = 0;
    let finishFrame!: () => void;
    const clock = { now: () => time, nextFrame: vi.fn(async () => time += 50) };
    window.setSize.mockImplementationOnce(() => new Promise<void>(resolve => { finishFrame = resolve; }));
    const controller = createCardWindowController(window, async () => null, clock);
    const entering = controller.enter({ animate: true });
    await vi.waitFor(() => expect(window.setSize).toHaveBeenCalledTimes(1));
    expect(clock.nextFrame).toHaveBeenCalledTimes(1);
    expect(window.setPosition).not.toHaveBeenCalled();
    finishFrame();
    await entering;
    expect(clock.nextFrame).toHaveBeenCalledTimes(4);
    expect(window.setSize).toHaveBeenLastCalledWith(new PhysicalSize(380, 560));
  });

  it('退出动画失败仍尝试准确还原几何与置顶，并保留快照供重试', async () => {
    const { window, state, normalSize, normalPosition } = fakeWindow();
    let time = 0;
    const clock = { now: () => time, nextFrame: vi.fn(async () => time += 50) };
    const controller = createCardWindowController(window, async () => null, clock);
    await controller.enter();
    window.setSize.mockRejectedValueOnce(new Error('exit frame failed'));
    await expect(controller.exit({ animate: true })).rejects.toThrow('exit frame failed');
    expect(state.size).toEqual(normalSize);
    expect(state.position).toEqual(normalPosition);
    expect(state.alwaysOnTop).toBe(false);
    expect(clock.nextFrame).toHaveBeenCalledTimes(1);
    await controller.exit();
    expect(window.setMinSize).toHaveBeenLastCalledWith(new LogicalSize(680, 480));
  });
  it('高 DPI 副屏中贴近底部的普通窗口进入后，整张卡片位于工作区内', async () => {
    const { window, state } = fakeWindow();
    state.position = new PhysicalPosition(-500, 1000);
    const originalPosition = state.position;
    const getMonitor: typeof currentMonitor = async () => ({
      name: 'secondary', scaleFactor: 2,
      size: new PhysicalSize(1920, 1440), position: new PhysicalPosition(-1920, 100),
      workArea: { position: new PhysicalPosition(-1920, 100), size: new PhysicalSize(1920, 1400) },
    });
    const controller = createCardWindowController(window, getMonitor);
    await controller.enter();
    expect(state.position).toEqual(new PhysicalPosition(-760, 380));
    await controller.exit();
    expect(state.position).toEqual(originalPosition);
  });

  it('工作区小于卡片最小尺寸时同步缩小最小尺寸，保留底部退出热区', async () => {
    const { window, state } = fakeWindow();
    const getMonitor: typeof currentMonitor = async () => ({
      name: 'small', scaleFactor: 2,
      size: new PhysicalSize(500, 660), position: new PhysicalPosition(300, 200),
      workArea: { position: new PhysicalPosition(300, 200), size: new PhysicalSize(500, 600) },
    });
    const controller = createCardWindowController(window, getMonitor);
    await controller.enter();
    expect(window.setMinSize).toHaveBeenLastCalledWith(new LogicalSize(250, 300));
    expect(window.setSize).toHaveBeenLastCalledWith(new LogicalSize(250, 300));
    expect(state.position).toEqual(new PhysicalPosition(300, 200));
  });
  it('缩小为竖向置顶卡片并恢复进入前的物理几何', async () => {
    const { window, state, normalSize, normalPosition } = fakeWindow();
    const controller = createCardWindowController(window);
    await controller.enter();
    expect(window.setMinSize).toHaveBeenCalledWith(new LogicalSize(300, 360));
    expect(window.setSize).toHaveBeenCalledWith(new LogicalSize(380, 560));
    expect(state.alwaysOnTop).toBe(true);
    await window.setPosition(new PhysicalPosition(800, 200));
    await controller.exit();
    expect(state.size).toEqual(normalSize);
    expect(state.position).toEqual(normalPosition);
    expect(state.alwaysOnTop).toBe(false);
    expect(window.setMinSize).toHaveBeenLastCalledWith(new LogicalSize(680, 480));
  });

  it('从最大化全屏进入时保存普通几何，退出先恢复几何再恢复显示状态', async () => {
    const { window, state, calls, normalSize } = fakeWindow(true, true, true);
    const controller = createCardWindowController(window);
    await controller.enter();
    expect(state.maximized).toBe(false);
    expect(state.fullscreen).toBe(false);
    calls.length = 0;
    await controller.exit();
    expect(state.size).toEqual(normalSize);
    expect(state.maximized).toBe(true);
    expect(state.fullscreen).toBe(true);
    expect(state.alwaysOnTop).toBe(true);
    expect(calls.indexOf('size')).toBeLessThan(calls.indexOf('maximize'));
    expect(calls.indexOf('position')).toBeLessThan(calls.indexOf('maximize'));
    expect(calls.indexOf('maximize')).toBeLessThan(calls.indexOf('fullscreen'));
  });

  it('进入中途失败时回滚几何和置顶，之后可以重新进入', async () => {
    const { window, state, normalSize } = fakeWindow();
    window.setAlwaysOnTop.mockRejectedValueOnce(new Error('pin failed'));
    const controller = createCardWindowController(window);
    await expect(controller.enter()).rejects.toThrow('pin failed');
    expect(state.size).toEqual(normalSize);
    expect(state.alwaysOnTop).toBe(false);
    await controller.enter();
    expect(state.alwaysOnTop).toBe(true);
  });

  it('退出失败保留原始快照供再次退出', async () => {
    const { window, state, normalPosition } = fakeWindow();
    const controller = createCardWindowController(window);
    await controller.enter();
    await window.setPosition(new PhysicalPosition(700, 100));
    window.setPosition.mockRejectedValueOnce(new Error('position failed'));
    await expect(controller.exit()).rejects.toThrow('position failed');
    expect(state.alwaysOnTop).toBe(false);
    await controller.exit();
    expect(state.position).toEqual(normalPosition);
    expect(state.alwaysOnTop).toBe(false);
  });

  it('连续进入幂等，快速进入退出串行完成且不覆盖普通快照', async () => {
    const { window, state, normalSize } = fakeWindow();
    const controller = createCardWindowController(window);
    await Promise.all([controller.enter(), controller.enter(), controller.exit()]);
    expect(state.size).toEqual(normalSize);
    expect(state.alwaysOnTop).toBe(false);
    expect(window.setSize.mock.calls.filter(([size]) => size.width === 380)).toHaveLength(1);
  });

  it('快照读取失败不修改窗口，也不会阻断后续操作', async () => {
    const { window } = fakeWindow();
    window.innerSize.mockRejectedValueOnce(new Error('read failed'));
    const controller = createCardWindowController(window);
    await expect(controller.enter()).rejects.toThrow('read failed');
    expect(window.setSize).not.toHaveBeenCalled();
    await controller.enter();
    expect(window.setSize).toHaveBeenCalledWith(new LogicalSize(380, 560));
  });

  it('进入失败且首次回滚失败时，下一次进入先恢复旧快照', async () => {
    const { window, state, normalSize, normalPosition } = fakeWindow();
    window.setAlwaysOnTop.mockRejectedValueOnce(new Error('pin failed'));
    window.setPosition.mockRejectedValueOnce(new Error('rollback failed'));
    const controller = createCardWindowController(window);
    await expect(controller.enter()).rejects.toThrow('进入卡片模式失败');
    await controller.enter();
    await controller.exit();
    expect(state.size).toEqual(normalSize);
    expect(state.position).toEqual(normalPosition);
    expect(state.alwaysOnTop).toBe(false);
  });
});
