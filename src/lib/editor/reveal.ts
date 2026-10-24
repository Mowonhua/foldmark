/**
 * 文件职责：统一导航定位的视口居中滚动，并为滚动提供可中断的动画。
 * 定义范围：居中目标测量、缓动滚动、用户操作取消；不修改正文、选区或折叠状态。
 */
import { EditorView } from '@codemirror/view';

const MIN_DURATION = 200;
const MAX_DURATION = 480;
const cancelEvents = ['wheel', 'touchstart', 'pointerdown', 'mousedown', 'keydown'] as const;

interface RunningScroll { frame: number; stop: () => void }
const running = new WeakMap<HTMLElement, RunningScroll>();

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

/**
 * 函数职责：把滚动容器缓动到目标偏移。
 * 输入说明：top/left 使用 scrollTop/scrollLeft 坐标，超界值按容器可滚动范围收敛。
 * 输出说明：新的定位请求替换尚未完成的动画；减少动态时直接落位。
 * 实现思路：动画时长随距离增长并设上限；滚轮、触摸、按下或按键视为用户接管，立即停止动画。
 */
export function animateScrollTo(scroller: HTMLElement, top: number, left: number): void {
  const win = scroller.ownerDocument.defaultView;
  running.get(scroller)?.stop();
  const targetTop = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
  const targetLeft = Math.max(0, Math.min(left, scroller.scrollWidth - scroller.clientWidth));
  const startTop = scroller.scrollTop, startLeft = scroller.scrollLeft;
  const reduced = win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  const distance = Math.hypot(targetTop - startTop, targetLeft - startLeft);
  if (!win || reduced || distance < 1) {
    scroller.scrollTop = targetTop; scroller.scrollLeft = targetLeft;
    return;
  }
  const duration = Math.min(MAX_DURATION, MIN_DURATION + Math.sqrt(distance) * 6);
  const started = win.performance.now();
  const state: RunningScroll = { frame: 0, stop: () => {} };
  state.stop = (): void => {
    if (state.frame) win.cancelAnimationFrame(state.frame);
    state.frame = 0;
    for (const type of cancelEvents) win.removeEventListener(type, state.stop, true);
    if (running.get(scroller) === state) running.delete(scroller);
  };
  const step = (now: number): void => {
    const progress = Math.min(1, (now - started) / duration);
    const eased = easeInOutCubic(progress);
    scroller.scrollTop = startTop + (targetTop - startTop) * eased;
    scroller.scrollLeft = startLeft + (targetLeft - startLeft) * eased;
    if (progress < 1) state.frame = win.requestAnimationFrame(step);
    else state.stop();
  };
  running.set(scroller, state);
  for (const type of cancelEvents) win.addEventListener(type, state.stop, true);
  state.frame = win.requestAnimationFrame(step);
}

/**
 * 导航滚动的唯一实现：只接管纵向居中请求。光标跟随和插入定位使用 nearest，保留原生即时滚动。
 * 输入说明：range 为定位目标；options 由 CodeMirror 的滚动目标提供。
 * 输出说明：已接管滚动返回 true；不是居中请求时返回 false，交回默认处理。
 * 实现思路：滚动处理器位于测量写阶段，坐标改到下一次测量的读取阶段获取；
 * 用目标与滚动容器中心的屏幕坐标差换算 scrollTop，避免直接访问未公开的行块坐标。
 */
export const revealViewport = EditorView.scrollHandler.of((view, range, options) => {
  if (options.y !== 'center') return false;
  const scroller = view.scrollDOM;
  const position = range.head;
  const assoc = range.assoc || (range.head < range.anchor ? -1 : 1);
  view.requestMeasure<{ top: number; left: number } | null>({
    key: revealViewport,
    read: () => {
      const viewportHeight = scroller.clientHeight;
      if (!viewportHeight) return null;
      const coords = view.coordsAtPos(position, assoc);
      if (!coords) return null;
      const bounds = scroller.getBoundingClientRect();
      const height = coords.bottom - coords.top;
      const scaleY = view.scaleY || 1, scaleX = view.scaleX || 1;
      // 目标高于视口时与默认滚动一致：贴住视口下缘，而不是让上下都溢出。
      const deltaY = height <= viewportHeight
        ? coords.top - (bounds.top + (viewportHeight - height) / 2)
        : coords.bottom - bounds.bottom + options.yMargin;
      const xMargin = options.xMargin / scaleX;
      let left = scroller.scrollLeft;
      if (coords.left < bounds.left + xMargin) left -= (bounds.left + xMargin - coords.left) / scaleX;
      else if (coords.right > bounds.right - xMargin) left += (coords.right - (bounds.right - xMargin)) / scaleX;
      return { top: scroller.scrollTop + deltaY / scaleY, left };
    },
    write: target => { if (target) animateScrollTo(scroller, target.top, target.left); },
  });
  return true;
});
