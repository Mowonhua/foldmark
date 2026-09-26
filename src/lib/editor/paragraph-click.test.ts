/** 文件职责：验证普通段落右侧空白定位，保护折行、正文点击及源码模式的原生行为。 */
import { afterEach, expect, it, vi } from 'vitest';
import { EditorController } from './index';
import { EditorView } from '@codemirror/view';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });

function setup(text: string, mode: 'todo' | 'source' = 'todo') {
  instance = new EditorController(document.body, { text, mode, onChange: () => {} });
  instance.focusAt(text.length);
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 150, right: 150, top: 10, bottom: 30 });
}

function click(options: MouseEventInit = {}) {
  const event = new MouseEvent('pointerdown', { button: 0, clientX: 300, clientY: 20, bubbles: true, cancelable: true, ...options });
  instance.view.contentDOM.querySelector('.cm-line')!.dispatchEvent(event);
  return event;
}

function mouse(type: string, options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { button: 0, buttons: type === 'mouseup' ? 0 : 1, detail: 1, clientX: 300, clientY: 20, bubbles: true, cancelable: true, ...options });
  (type === 'mousedown' ? instance.view.contentDOM.querySelector('.cm-line')! : document).dispatchEvent(event);
  return event;
}

it.each(['普通段落\n\n下一段', '普通段落\n\n- [ ] 任务', '普通段落\n下一行', '普通段落'])('右侧空白定位本源码行末尾：%j', text => {
  setup(text);
  expect(click().defaultPrevented).toBe(false);
  mouse('mousedown'); mouse('mouseup');
  expect(instance.state.selection.main.head).toBe(4);
  expect(instance.text).toBe(text);
  expect(instance.undo()).toBe(false);
});

it('从行尾右侧按下后可向前拖选，保留行尾锚点和终点方向', () => {
  setup('普通段落\n\n下一段');
  vi.spyOn(instance.view, 'posAndSideAtCoords').mockReturnValue({ pos: 1, assoc: 1 });
  expect(click().defaultPrevented).toBe(false);
  mouse('mousedown');
  mouse('mousemove', { clientX: 110 });
  mouse('mouseup', { clientX: 110 });
  expect(instance.state.selection.main.anchor).toBe(4);
  expect(instance.state.selection.main.head).toBe(1);
  expect(instance.state.sliceDoc(1, 4)).toBe('通段落');
  expect(instance.undo()).toBe(false);
});

it.each([
  { clientX: 120 }, { clientY: 5 }, { clientY: 35 },
  { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { button: 2 }, { detail: 2 }, { detail: 3 },
])('正文、其他视觉行或修饰点击保留原生行为：%j', options => {
  setup('普通段落\n\n下一段');
  expect(click(options).defaultPrevented).toBe(false);
  expect(instance.state.selection.main.head).toBe(instance.text.length);
  const event = new MouseEvent('mousedown', { button: 0, detail: 1, clientX: 300, clientY: 20, ...options });
  Object.defineProperty(event, 'target', { value: instance.view.contentDOM.querySelector('.cm-line') });
  expect(instance.state.facet(EditorView.mouseSelectionStyle).every(make => make(instance.view, event) === null)).toBe(true);
});

it('源码模式不接管右侧空白定位', () => {
  setup('普通段落\n\n下一段', 'source');
  expect(click().defaultPrevented).toBe(false);
});
