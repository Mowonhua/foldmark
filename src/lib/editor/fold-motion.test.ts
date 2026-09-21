/** 文件职责：验证折叠位移的行关联、降级与交互中断，不依赖浏览器真实动画计时。 */
import { EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoldMotion } from './fold-motion';
import { modeFacet } from './state';

const instances: FoldMotion[] = [];
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
afterEach(() => {
  instances.forEach(instance => instance.destroy());
  instances.length = 0;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
});

function fixture(mode: 'todo' | 'source' = 'todo', reduced = false) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })));
  const animations: { cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
  const animate = vi.fn(function (this: HTMLElement, _frames: Keyframe[], _options: KeyframeAnimationOptions) {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const animation = { cancel: vi.fn(), finished, finish };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true, writable: true });
  const dom = document.createElement('div');
  const scrollDOM = document.createElement('div');
  const contentDOM = document.createElement('div');
  dom.append(scrollDOM); scrollDOM.append(contentDOM); document.body.append(dom);
  scrollDOM.getBoundingClientRect = () => new DOMRect(0, 0, 500, 400);
  const state = EditorState.create({ doc: 'a\nb\nc\nd', extensions: [modeFacet.of(mode)] });
  const requestMeasure = vi.fn();
  const view = { dom, scrollDOM, contentDOM, state, requestMeasure, posAtDOM: (node: Node) => Number((node as HTMLElement).dataset.from) };
  const motion = new FoldMotion(view); instances.push(motion);
  function line(from: number, top: number) {
    const element = document.createElement('div'); element.className = 'cm-line'; element.dataset.from = String(from);
    element.getBoundingClientRect = () => new DOMRect(0, top, 400, 20);
    contentDOM.append(element);
    return element;
  }
  function flush(index = requestMeasure.mock.calls.length - 1) {
    const request = requestMeasure.mock.calls[index]?.[0];
    if (request) request.write(request.read(view), view);
  }
  return { motion, view, line, flush, requestMeasure, animate, animations };
}

describe('折叠行位移动画', () => {
  it('按文档位置关联替换后的行，并在测量完成后从旧位置平移到新位置', () => {
    const f = fixture();
    f.line(0, 10); const oldNext = f.line(4, 110);
    f.motion.run(() => { oldNext.remove(); f.line(4, 30); });
    expect(f.animate).not.toHaveBeenCalled();
    f.flush();
    expect(f.animate).toHaveBeenCalledTimes(1);
    expect(f.animate).toHaveBeenCalledWith([
      { transform: 'translateY(80px)' }, { transform: 'translateY(0)' },
    ], expect.objectContaining({ duration: 180 }));
    expect(f.animate.mock.contexts[0].className).toBe('cm-line');
    expect(f.view.contentDOM.style.transform).toBe('');
  });

  it('展开让保留的后续行向下滑动，忽略新出现行和视口外缓冲行', () => {
    const f = fixture();
    const next = f.line(4, 40); const outside = f.line(6, 500);
    f.motion.run(() => {
      next.getBoundingClientRect = () => new DOMRect(0, 140, 400, 20);
      outside.getBoundingClientRect = () => new DOMRect(0, 300, 400, 20);
      f.line(2, 60);
    });
    f.flush();
    expect(f.animate).toHaveBeenCalledTimes(1);
    expect(f.animate.mock.calls[0][0][0].transform).toBe('translateY(-100px)');
  });

  it.each([['source', false], ['todo', true]] as const)('%s / reduced=%s 直接折叠不读写动画布局', (mode, reduced) => {
    const f = fixture(mode, reduced); const change = vi.fn();
    f.motion.run(change);
    expect(change).toHaveBeenCalledTimes(1);
    expect(f.requestMeasure).not.toHaveBeenCalled();
    expect(f.animate).not.toHaveBeenCalled();
  });

  it.each(['pointermove', 'pointerdown', 'keydown', 'beforeinput', 'scroll', 'wheel'])('%s 取消活动动画，并使旧测量失效', eventName => {
    const f = fixture(); const line = f.line(0, 100);
    f.motion.run(() => { line.getBoundingClientRect = () => new DOMRect(0, 40, 400, 20); });
    f.flush();
    const target = eventName === 'scroll' || eventName === 'wheel' ? f.view.scrollDOM : f.view.dom;
    target.dispatchEvent(new Event(eventName));
    expect(f.animations[0].cancel).toHaveBeenCalledTimes(1);
    f.motion.run(() => { line.getBoundingClientRect = () => new DOMRect(0, 10, 400, 20); });
    target.dispatchEvent(new Event(eventName));
    f.flush();
    expect(f.animate).toHaveBeenCalledTimes(1);
  });

  it('再次折叠只允许最新测量启动，销毁后也不能启动动画', () => {
    const f = fixture(); const line = f.line(0, 100);
    f.motion.run(() => { line.getBoundingClientRect = () => new DOMRect(0, 60, 400, 20); });
    f.motion.run(() => { line.getBoundingClientRect = () => new DOMRect(0, 10, 400, 20); });
    f.flush(0); expect(f.animate).not.toHaveBeenCalled();
    f.flush(1); expect(f.animate).toHaveBeenCalledTimes(1);
    f.motion.run(() => { line.getBoundingClientRect = () => new DOMRect(0, 0, 400, 20); });
    f.motion.destroy(); f.flush();
    expect(f.animate).toHaveBeenCalledTimes(1);
    expect(f.animations[0].cancel).toHaveBeenCalledTimes(1);
  });

  it('外部正文更新使尚未执行的测量失效', () => {
    const f = fixture(); const line = f.line(0, 100);
    f.motion.run(() => { line.getBoundingClientRect = () => new DOMRect(0, 60, 400, 20); });
    f.motion.update({ docChanged: true, selectionSet: false, state: f.view.state, startState: f.view.state });
    f.flush(); expect(f.animate).not.toHaveBeenCalled();
  });
});
