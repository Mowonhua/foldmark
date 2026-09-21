/**
 * 文件职责：协调桌面窗口进入和退出卡片模式时的原生状态。
 * 定义范围：窗口状态快照、可替换的窗口操作依赖和串行模式控制器。
 */
import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import type { Window } from '@tauri-apps/api/window';

/**
 * 结构职责：限定卡片切换需要的原生窗口能力。
 * 字段说明：读写操作沿用 Tauri 的物理坐标和逻辑尺寸类型。
 * 约束条件：由同一个窗口实现全部操作，测试可注入等价替身。
 */
export type CardWindow = Pick<Window, 'innerSize' | 'outerPosition' | 'scaleFactor' | 'isMaximized' | 'isFullscreen' | 'isAlwaysOnTop' | 'setSize' | 'setPosition' | 'setMinSize' | 'setAlwaysOnTop' | 'setFullscreen' | 'maximize' | 'unmaximize'>;

/**
 * 结构职责：由调用方决定本次切换是否使用原生几何动画。
 * 字段说明：animate 缺省为 false，减少动态效果时传 false。
 * 约束条件：只影响正常进入和退出，故障回滚始终立即执行。
 */
export interface CardWindowTransitionOptions { animate?: boolean }

/**
 * 接口职责：为窗口过渡提供单调时钟和帧间等待。
 * 调用方：窗口控制器内部的物理几何插值过程。
 * 实现要求：时间单位为毫秒且单调递增；nextFrame 只在前一帧原生调用完成后调度。
 */
export interface CardWindowAnimationClock {
  now(): number;
  nextFrame(): Promise<number>;
}

/**
 * 结构职责：保留普通窗口几何和进入卡片前的显示状态。
 * 字段说明：size 和 position 为解除全屏、最大化后的物理尺寸与位置。
 * 约束条件：仅在完整退出成功后清除，失败后仍可重试恢复。
 */
interface WindowSnapshot {
  size: PhysicalSize;
  position: PhysicalPosition;
  maximized: boolean;
  fullscreen: boolean;
  alwaysOnTop: boolean;
}

/**
 * 接口职责：提供原生卡片模式切换，不处理应用面板显隐。
 * 调用方：仅在桌面环境调用的应用状态协调层。
 * 实现要求：操作串行且幂等；进入失败回滚，退出失败保留恢复状态。
 */
export interface CardWindowController {
  enter(options?: CardWindowTransitionOptions): Promise<void>;
  exit(options?: CardWindowTransitionOptions): Promise<void>;
}

/**
 * 函数职责：为一个桌面窗口创建卡片模式控制器。
 * 输入说明：默认使用当前 Tauri 窗口及显示器，测试可注入窗口和显示器查询替身。
 * 输出说明：成功进入后窗口为竖向置顶卡片；退出恢复原状态，失败向调用方抛错。
 * 实现思路：串行保存快照并切换尺寸，恢复时先还原普通几何再恢复最大化和全屏。
 */
export function createCardWindowController(
  window: CardWindow = getCurrentWindow(),
  getMonitor: typeof currentMonitor = currentMonitor,
  clock?: CardWindowAnimationClock,
): CardWindowController {
  let snapshot: WindowSnapshot | undefined;
  let entered = false;
  let queue: Promise<void> = Promise.resolve();
  const animationClock: CardWindowAnimationClock = clock ?? {
    now: () => performance.now(),
    // 原生窗口的尺寸变化不能依赖 WebView 是否正在绘制；后台限帧时仍须完成切换。
    nextFrame: () => new Promise(resolve => setTimeout(() => resolve(performance.now()), 16)),
  };

  // 内部队列吞掉异常只为允许后续重试；每次调用仍通过 operation 收到自身错误。
  function enqueue(action: () => Promise<void>): Promise<void> {
    const operation = queue.then(action);
    queue = operation.catch(() => {});
    return operation;
  }

  /** 只写入中间帧；调用方始终另外提交精确终值，避免时间取样和取整造成终点误差。 */
  async function animateGeometry(size: PhysicalSize, position: PhysicalPosition): Promise<void> {
    const [fromSize, fromPosition] = await Promise.all([window.innerSize(), window.outerPosition()]);
    const started = animationClock.now();
    while (true) {
      const elapsed = await animationClock.nextFrame() - started;
      const progress = Math.min(1, Math.max(0, elapsed / 200));
      if (progress === 1) return;
      const eased = 1 - (1 - progress) ** 3;
      // 坐标和尺寸全程使用物理像素；等待两次 IPC 完成后才取下一帧，慢设备不会积压旧帧。
      await window.setSize(new PhysicalSize(
        Math.round(fromSize.width + (size.width - fromSize.width) * eased),
        Math.round(fromSize.height + (size.height - fromSize.height) * eased),
      ));
      await window.setPosition(new PhysicalPosition(
        Math.round(fromPosition.x + (position.x - fromPosition.x) * eased),
        Math.round(fromPosition.y + (position.y - fromPosition.y) * eased),
      ));
    }
  }

  async function restore(options: CardWindowTransitionOptions = {}): Promise<void> {
    if (!snapshot) return;
    const saved = snapshot;
    const errors: unknown[] = [];
    // 恢复必须尽量执行全部步骤，避免单次几何错误使窗口永久保留置顶属性。
    // 先解除显示状态、恢复普通几何，再最大化/全屏，保留系统的正常还原尺寸。
    const steps = [
      () => window.setFullscreen(false),
      () => window.unmaximize(),
      ...(options.animate ? [() => animateGeometry(saved.size, saved.position)] : []),
      () => window.setSize(saved.size),
      () => window.setPosition(saved.position),
      // 必须先完成放大再恢复普通最小尺寸，否则窗口会在动画第一帧前突然扩到 680px。
      () => window.setMinSize(new LogicalSize(680, 480)),
      () => window.setAlwaysOnTop(saved.alwaysOnTop),
      ...(saved.maximized ? [() => window.maximize()] : []),
      ...(saved.fullscreen ? [() => window.setFullscreen(true)] : []),
    ];
    for (const step of steps) {
      try { await step(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '恢复窗口状态失败');
    snapshot = undefined;
    entered = false;
  }

  async function enter(options: CardWindowTransitionOptions = {}): Promise<void> {
    if (entered) return;
    // 上次进入的回滚若未成功，必须先完成恢复，不能用半成品状态覆盖原快照。
    if (snapshot) await restore();
    const [size, position, maximized, fullscreen, alwaysOnTop] = await Promise.all([
      window.innerSize(), window.outerPosition(), window.isMaximized(),
      window.isFullscreen(), window.isAlwaysOnTop(),
    ]);
    snapshot = { size, position, maximized, fullscreen, alwaysOnTop };
    try {
      if (fullscreen) await window.setFullscreen(false);
      if (maximized) await window.unmaximize();
      // 最大化/全屏下读取的是显示器几何，只有解除后才是窗口正常还原几何。
      const [normalSize, normalPosition, monitor] = await Promise.all([
        window.innerSize(), window.outerPosition(), getMonitor(),
      ]);
      snapshot.size = normalSize;
      snapshot.position = normalPosition;
      const scale = monitor?.scaleFactor ?? (options.animate ? await window.scaleFactor() : 1);
      const workArea = monitor?.workArea;
      const width = Math.min(380, workArea ? workArea.size.width / scale : 380);
      const height = Math.min(560, workArea ? workArea.size.height / scale : 560);
      // 小工作区必须连最小尺寸一并降低，否则系统会扩大窗口使底部退出入口落到屏外。
      await window.setMinSize(new LogicalSize(Math.min(300, width), Math.min(360, height)));
      let cardPosition = normalPosition;
      if (workArea) {
        // 坐标和工作区都是物理像素；只转换卡片逻辑尺寸，保留副屏的非零或负坐标原点。
        const x = Math.max(workArea.position.x, Math.min(normalPosition.x, workArea.position.x + workArea.size.width - Math.round(width * scale)));
        const y = Math.max(workArea.position.y, Math.min(normalPosition.y, workArea.position.y + workArea.size.height - Math.round(height * scale)));
        cardPosition = new PhysicalPosition(x, y);
      }
      const cardSize = new PhysicalSize(Math.round(width * scale), Math.round(height * scale));
      if (options.animate) await animateGeometry(cardSize, cardPosition);
      await window.setSize(options.animate ? cardSize : new LogicalSize(width, height));
      if (workArea || options.animate) await window.setPosition(cardPosition);
      await window.setAlwaysOnTop(true);
      entered = true;
    } catch (error) {
      try { await restore(); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], '进入卡片模式失败，窗口恢复需要重试');
      }
      throw error;
    }
  }

  return {
    enter: (options) => enqueue(() => enter(options)),
    exit: (options) => enqueue(() => restore(options)),
  };
}
