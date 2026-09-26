/** 文件职责：验证空任务正文定位和末尾空段落的分隔补齐，不接管任务控件手势。 */
import { afterEach, expect, it, vi } from 'vitest';
import { EditorController } from './index';
import { paragraphLayout } from './paragraphs';
import { hiddenContentRanges } from './visibility';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });
function editor(text: string) {
  instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} });
}

it('从已创建空行本身起拖可选择前文，不重复创建段落', () => {
  const text = '正文\n\n';
  editor(text);
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  vi.spyOn(instance.view, 'posAndSideAtCoords').mockReturnValue({ pos: 0, assoc: 1 });
  const line = instance.view.contentDOM.querySelector('[data-empty-paragraph-from]')!;
  const down = new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 40, bubbles: true, cancelable: true });
  line.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(false);
  line.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, detail: 1, clientX: 100, clientY: 40, bubbles: true, cancelable: true }));
  document.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 10, clientY: 10, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
  expect(instance.state.selection.main.anchor).toBe(text.length);
  expect(instance.state.selection.main.head).toBe(0);
  expect(instance.text).toBe(text);
  expect(instance.undo()).toBe(false);
});

it.each([
  ['正文', '正文\n\n'],
  ['正文\n\n', '正文\n\n'],
  ['正文\n\n# 归档\n\n- [x] 完成\n', '正文\n\n\n\n# 归档\n\n- [x] 完成\n'],
].flatMap(([text, expected]) => (['contentDOM', 'scrollDOM'] as const).map(target => ({ text, expected, target }))))('从底部空白按下创建或复用空段落后继续向前拖选：%j', ({ text, expected, target }) => {
  editor(text);
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  vi.spyOn(instance.view, 'posAndSideAtCoords').mockReturnValue({ pos: 0, assoc: 1 });
  instance.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
  const down = new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true });
  instance.view[target].dispatchEvent(down);
  expect(down.defaultPrevented).toBe(false);
  expect(instance.text).toBe(expected);
  instance.view[target].dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, detail: 1, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  document.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 10, clientY: 30, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 10, clientY: 30, bubbles: true }));
  expect(instance.state.selection.main.anchor).toBe(4);
  expect(instance.state.selection.main.head).toBe(0);
  expect(instance.text).toBe(expected);
  if (expected !== text) { expect(instance.undo()).toBe(true); expect(instance.text).toBe(text); }
});

it.each([
  ['- [ ] 任务', '- [ ] 任务\n\n'],
  ['- [ ] 任务\n\n# 归档\n\n- [x] 完成\n', '- [ ] 任务\n\n\n\n# 归档\n\n- [x] 完成\n'],
])('点击可见列表下方创建带分隔的空段落：%j', (text, expected) => {
  editor(text);
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  instance.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
  const click = () => instance.view.contentDOM.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  click();
  expect(instance.text).toBe(expected);
  expect(instance.state.selection.main.head).toBe('- [ ] 任务\n\n'.length);
  click();
  expect(instance.text).toBe(expected);
  instance.view.dispatch(instance.state.replaceSelection('正文'));
  expect(instance.text).toBe(expected.replace('- [ ] 任务\n\n', '- [ ] 任务\n\n正文'));
  expect(hiddenContentRanges(instance.state).some(range => instance.state.selection.main.head > range.from && instance.state.selection.main.head < range.to)).toBe(false);
});

it('底部新增空段落不改写前面紧凑任务间距', () => {
  const text = '- [ ] 前\n- [ ] 后';
  editor(text);
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  instance.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
  instance.view.contentDOM.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  expect(instance.text).toBe(text + '\n\n');
});

it('点击任务后的单尾空行补齐段落分隔，输入保持独立正文且可撤销', () => {
  const text = '- [ ] 任务\n';
  editor(text);
  const line = instance.view.contentDOM.querySelector('[data-empty-paragraph-from]')!;
  line.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
  expect(instance.text).toBe('- [ ] 任务\n\n');
  expect(instance.state.selection.main.head).toBe(instance.text.length);
  expect(paragraphLayout(instance.state).separators).toHaveLength(1);
  expect(instance.undo()).toBe(true);
  expect(instance.text).toBe(text);
  expect(instance.redo()).toBe(true);
  instance.view.contentDOM.querySelector('[data-empty-paragraph-from]')!
    .dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
  instance.view.dispatch(instance.state.replaceSelection('正文'));
  expect(instance.text).toBe('- [ ] 任务\n\n正文');
  expect(paragraphLayout(instance.state).paragraphs.at(-1)?.item).toBeNull();
});

it.each(['', '- [ ] 任务\n\n', '- [ ] 任务\n\n\n\n'])('已有空段落重复点击不增加分隔：%j', text => {
  editor(text);
  for (let count = 0; count < 2; count++) {
    const line = instance.view.contentDOM.querySelectorAll('[data-empty-paragraph-from]');
    line[line.length - 1].dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
  }
  expect(instance.text).toBe(text);
  expect(instance.undo()).toBe(false);
});

it('补齐嵌套任务尾部空段落的分隔时保留正文缩进', () => {
  editor('- [ ] 父\n  - [ ] 子\n    ');
  const owner = paragraphLayout(instance.state).paragraphs.at(-1)!.item!.from;
  instance.view.contentDOM.querySelector('[data-empty-paragraph-from]')!
    .dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
  expect(instance.text).toBe('- [ ] 父\n  - [ ] 子\n\n    ');
  expect(instance.state.selection.main.head).toBe(instance.text.length);
  expect(paragraphLayout(instance.state).paragraphs.at(-1)!.item!.from).toBe(owner);
});

it.each(['contentDOM', 'scrollDOM'] as const)('点击 %s 下方留白也补齐末尾空段落分隔', target => {
  editor('- [ ] 任务\n');
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  instance.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
  instance.view[target].dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  expect(instance.text).toBe('- [ ] 任务\n\n');
  expect(instance.state.selection.main.head).toBe(instance.text.length);
});

it.each([{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { button: 2 }])('尾部空段落的修饰点击不修改文档：%j', options => {
  const text = '- [ ] 任务\n';
  editor(text);
  instance.view.contentDOM.querySelector('[data-empty-paragraph-from]')!
    .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, ...options }));
  expect(instance.text).toBe(text);
  expect(instance.undo()).toBe(false);
});

it('点击 Shift+Enter 创建的空软续行不补段落分隔', () => {
  editor('- [ ] 任务'); instance.focusAt(instance.text.length);
  instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  const text = instance.text;
  const lines = instance.view.contentDOM.querySelectorAll('.cm-line');
  lines[lines.length - 1].dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
  expect(instance.text).toBe(text);
  expect(paragraphLayout(instance.state).separators).toHaveLength(0);
});

it.each([
  '- [ ] ',
  '- [ ] \n\n- [ ] 后',
  '- [ ] 前\n\n- [ ] ',
  '- [ ] 前\n\n- [ ] \n\n- [ ] 后',
  '- [ ] 父\n\n  - [ ] \n\n  - [ ] 后',
  '- [ ] 前\n\n- [ ] \n  正文\n- [ ] 后',
])('点击空任务正文定位到正文起点：%j', text => {
  editor(text);
  const item = instance.model.tasks.find(item => item.contentFrom === item.firstLineTo)!;
  const marker = instance.view.dom.querySelector<HTMLElement>(`[data-list-marker="${item.from}"]`)!;
  marker.getBoundingClientRect = () => new DOMRect(10, 10, 17, 20);
  for (const [target, clientX] of [[marker.parentElement!, 30], [marker.closest('.cm-line')!, 300]] as const) {
    instance.focusAt(item.contentFrom === text.length ? 0 : text.length);
    const event = new MouseEvent('pointerdown', { button: 0, clientX, clientY: 20, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    expect(instance.state.selection.main.head).toBe(item.contentFrom);
    expect(instance.view.hasFocus).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(instance.text).toBe(text);
  }
  expect(instance.undo()).toBe(false);
});

it.each([{ shiftKey: true }, { ctrlKey: true }, { button: 2 }])('修饰键或右键保留浏览器原始交互：%j', options => {
  editor('- [ ] \n\n- [ ] 后'); instance.focusAt(instance.text.length);
  const original = instance.state.selection.main.head;
  const line = instance.view.contentDOM.querySelector('.cm-line')!;
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 300, ...options });
  line.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(instance.state.selection.main.head).toBe(original);
});

it('有正文的任务不接管原生文字定位', () => {
  editor('- [ ] 有文字\n- [ ] 后'); instance.focusAt(instance.text.length);
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 300 });
  instance.view.contentDOM.querySelector('.cm-line')!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});
