/** 文件职责：验证导航滚动的居中目标计算、缓动、减少动态与用户接管。 */
import { expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { animateScrollTo, revealViewport } from './reveal';

interface FakeWindowOptions { reduced?: boolean }

function fakeScroller(options: FakeWindowOptions = {}) {
  let now = 0;
  let handle = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const listeners = new Map<string, EventListener>();
  const win = {
    matchMedia: () => ({ matches: options.reduced ?? false }),
    performance: { now: () => now },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++handle, callback); return handle; },
    cancelAnimationFrame: (target: number) => { frames.delete(target); },
    addEventListener: (type: string, listener: EventListener) => { listeners.set(type, listener); },
    removeEventListener: (type: string, listener: EventListener) => { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const scroller = {
    scrollTop: 0, scrollLeft: 0, scrollHeight: 1000, clientHeight: 200, scrollWidth: 500, clientWidth: 500,
    ownerDocument: { defaultView: win },
    getBoundingClientRect: () => new DOMRect(0, 0, 500, 200),
  };
  return {
    scroller: scroller as unknown as HTMLElement,
    step(ms: number) { now += ms; const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(now); },
    pending: () => frames.size,
    fire(type: string) { listeners.get(type)?.(new Event(type)); },
  };
}

function navigationHandler() {
  return EditorState.create({ extensions: [revealViewport] }).facet(EditorView.scrollHandler)[0];
}

function fakeView(fake: ReturnType<typeof fakeScroller>, coords: { left: number; right: number; top: number; bottom: number }) {
  const view = {
    scrollDOM: fake.scroller,
    scaleX: 1, scaleY: 1,
    coordsAtPos: () => coords,
    requestMeasure: (request: { read: () => unknown; write: (value: unknown) => void }) => request.write(request.read()),
  };
  return view as unknown as EditorView;
}

it('导航滚动把目标放到视口中心', () => {
  const fake = fakeScroller({ reduced: true });
  const scroll = fake.scroller;
  scroll.scrollTop = 100;
  const handled = navigationHandler()(fakeView(fake, { left: 10, right: 100, top: 300, bottom: 320 }), EditorSelection.cursor(0), { y: 'center', x: 'nearest', xMargin: 0, yMargin: 0 });
  expect(handled).toBe(true);
  // 当前 100 + 目标行顶部 300 − 行在视口中居中时的顶部偏移 90
  expect(scroll.scrollTop).toBe(310);
});

it('不接管最近滚动，避免光标跟随时被动画拖慢', () => {
  const fake = fakeScroller();
  fake.scroller.scrollTop = 100;
  const handled = navigationHandler()(fakeView(fake, { left: 10, right: 100, top: 300, bottom: 320 }), EditorSelection.cursor(0), { y: 'nearest', x: 'nearest', xMargin: 0, yMargin: 0 });
  expect(handled).toBe(false);
  expect(fake.scroller.scrollTop).toBe(100);
});

it('动画按缓动曲线推进并在结束后停止', () => {
  const fake = fakeScroller();
  const scroll = fake.scroller;
  animateScrollTo(scroll, 600, 0);
  expect(scroll.scrollTop).toBe(0);
  expect(fake.pending()).toBe(1);
  fake.step(0);
  const duration = 200 + Math.sqrt(600) * 6;
  fake.step(duration / 2);
  expect(scroll.scrollTop).toBeCloseTo(300, 0);
  fake.step(duration / 2 + 1);
  expect(scroll.scrollTop).toBe(600);
  expect(fake.pending()).toBe(0);
});

it('减少动态时直接落位并收敛到可滚动范围', () => {
  const fake = fakeScroller({ reduced: true });
  animateScrollTo(fake.scroller, 9000, 0);
  expect(fake.scroller.scrollTop).toBe(800);
  expect(fake.pending()).toBe(0);
});

it('用户滚动立即中断动画', () => {
  const fake = fakeScroller();
  animateScrollTo(fake.scroller, 600, 0);
  fake.step(0);
  fake.step(100);
  const partial = fake.scroller.scrollTop;
  expect(partial).toBeGreaterThan(0);
  fake.fire('wheel');
  expect(fake.pending()).toBe(0);
  fake.step(1000);
  expect(fake.scroller.scrollTop).toBe(partial);
});
