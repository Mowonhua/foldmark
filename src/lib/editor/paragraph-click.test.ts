/** 文件职责：验证同一视觉行末右侧空白的定位覆盖各类行形状，并保护隐藏整行、折行、正文点击及源码模式的原生行为。 */
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

/** 按源码行号取渲染行，隐藏的分隔行不占用下标。 */
function lineOf(number: number): Element {
  const view = instance.view;
  return [...view.contentDOM.querySelectorAll<Element>('.cm-line')].find(el => view.state.doc.lineAt(view.posAtDOM(el, 0)).number === number)!;
}

function click(options: MouseEventInit = {}, target?: Element) {
  const event = new MouseEvent('pointerdown', { button: 0, clientX: 300, clientY: 20, bubbles: true, cancelable: true, ...options });
  (target ?? lineOf(1)).dispatchEvent(event);
  return event;
}

function mouse(type: string, options: MouseEventInit = {}, target?: Element) {
  const event = new MouseEvent(type, { button: 0, buttons: type === 'mouseup' ? 0 : 1, detail: 1, clientX: 300, clientY: 20, bubbles: true, cancelable: true, ...options });
  (type === 'mousedown' ? (target ?? lineOf(1)) : document).dispatchEvent(event);
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

/** 链接行末的隐藏换行会让原生命中落到下一源码行起点，各类行形状都定位本源码行末尾。 */
it.each([
  { shape: '正文链接', doc: '正文 [AAA](a/link)\n\n下一段', number: 1, end: 16 },
  { shape: '标题链接', doc: '# 标题 [AAA](a/link)\n\n下一段', number: 1, end: 18 },
  { shape: '引用链接', doc: '> 引用 [AAA](a/link)\n\n下一段', number: 1, end: 18 },
  { shape: '任务链接', doc: '- [ ] 任务 [AAA](a/link)\n\n下一段', number: 1, end: 22 },
  { shape: '二级任务链接', doc: '- [ ] 父项\n  - [ ] 子项 [AAA](a/link)\n\n下一段', number: 2, end: 33 },
  { shape: '标题', doc: '# 标题文字\n\n下一段', number: 1, end: 6 },
  { shape: '引用', doc: '> 引用文字\n\n下一段', number: 1, end: 6 },
  { shape: '任务', doc: '- [ ] 任务文字\n\n下一段', number: 1, end: 10 },
  { shape: '代码正文', doc: '```js\nconst a = 1\n```\n\n下一段', number: 2, end: 17 },
])('右侧空白定位本源码行末尾：%j', ({ doc, number, end }) => {
  setup(doc);
  const target = lineOf(number);
  expect(click({}, target).defaultPrevented).toBe(false);
  mouse('mousedown', {}, target); mouse('mouseup');
  expect(instance.state.selection.main.head).toBe(end);
  expect(instance.text).toBe(doc);
  expect(instance.undo()).toBe(false);
});

/** 整行正文隐藏（围栏、分隔线、空任务）没有可见行末，继续由各自点击契约处理。 */
it.each([
  { shape: '开围栏行', doc: '```js\nconst a = 1\n```\n\n下一段', number: 1 },
  { shape: '闭围栏行', doc: '```js\nconst a = 1\n```\n\n下一段', number: 3 },
  { shape: '分隔线行', doc: '---\n\n下一段', number: 1 },
  { shape: '空任务行', doc: '- [ ] \n\n下一段', number: 1 },
])('整行正文隐藏的右侧空白保留原生行为：%j', ({ doc, number }) => {
  setup(doc);
  const target = lineOf(number);
  expect(target.textContent?.trim()).toBeFalsy();
  const event = new MouseEvent('mousedown', { button: 0, detail: 1, clientX: 300, clientY: 20 });
  Object.defineProperty(event, 'target', { value: target });
  expect(instance.state.facet(EditorView.mouseSelectionStyle).every(make => make(instance.view, event) === null)).toBe(true);
});
