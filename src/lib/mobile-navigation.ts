/**
 * 文件职责：识别手机导航抽屉的触屏手势。
 * 定义范围：手势起点、方向判定与结束清理；不接管正文触摸事件。
 */

/**
 * 结构职责：提供抽屉当前状态及唯一开关出口。
 * 字段说明：blocked 表示已有弹窗或界面锁，不允许导航手势。
 * 约束条件：所有函数均在事件发生时读取当前状态。
 */
export interface DrawerGestureOptions {
  isOpen: () => boolean;
  blocked: () => boolean;
  setOpen: (open: boolean) => void;
}

/**
 * 函数职责：为窗口注册手机抽屉左右滑动识别。
 * 输入说明：仅挂载到手机界面，关闭时仅接受视口左半屏起点，打开时仅接受侧栏或遮罩起点。
 * 输出说明：返回卸载函数；多指、纵向滚动、输入与文本选择不触发抽屉。
 * 实现思路：记录单指起点，在结束时判断水平距离和方向，不取消浏览器默认事件。
 */
export function registerDrawerGestures(options: DrawerGestureOptions): () => void {
  let start: { x: number; y: number; open: boolean } | undefined;
  const begin = (event: TouchEvent) => {
    start = undefined;
    if (event.touches.length !== 1 || options.blocked()) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('input, textarea, select, [role="dialog"], [role="menu"], [data-global-search]')) return;
    if (window.getSelection()?.toString()) return;
    const touch = event.touches[0], open = options.isOpen();
    if (open ? !target.closest('.sidebar, .drawer-scrim') : touch.clientX > window.innerWidth / 2) return;
    start = { x: touch.clientX, y: touch.clientY, open };
  };
  const move = (event: TouchEvent) => {
    if (!start) return;
    // 一旦确认纵向滚动就放弃本轮，不能在抬手时因回摆又识别为横滑。
    if (event.touches.length !== 1 || Math.abs(event.touches[0].clientY - start.y) > 32) start = undefined;
  };
  const end = (event: TouchEvent) => {
    const origin = start; start = undefined;
    if (!origin || event.changedTouches.length !== 1 || options.blocked() || origin.open !== options.isOpen()) return;
    const touch = event.changedTouches[0], dx = touch.clientX - origin.x, dy = touch.clientY - origin.y;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 2 || window.getSelection()?.toString()) return;
    if (origin.open ? dx < 0 : dx > 0) options.setOpen(!origin.open);
  };
  const cancel = () => { start = undefined; };
  window.addEventListener('touchstart', begin, { passive: true, capture: true });
  window.addEventListener('touchmove', move, { passive: true, capture: true });
  window.addEventListener('touchend', end, { passive: true, capture: true });
  window.addEventListener('touchcancel', cancel, { passive: true, capture: true });
  return () => {
    window.removeEventListener('touchstart', begin, true);
    window.removeEventListener('touchmove', move, true);
    window.removeEventListener('touchend', end, true);
    window.removeEventListener('touchcancel', cancel, true);
  };
}
