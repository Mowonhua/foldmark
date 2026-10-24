/** 文件职责：验证空任务正文定位和末尾空段落的分隔补齐，不接管任务控件手势。 */
import { afterEach, expect, it, vi } from 'vitest';
import type { TransactionSpec } from '@codemirror/state';
import { EditorController } from './index';
import { paragraphLayout } from './paragraphs';
import { hiddenContentRanges } from './visibility';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });
function editor(text: string, nativeSelection = false) {
  instance = new EditorController(document.body, { text, mode: 'todo', nativeSelection, onChange: () => {} });
}

it('手机轻触底部留白创建可见编辑出口，不把输入送入隐藏归档', () => {
  const text = '- [ ] 任务\n\n# 归档\n\n- [x] 完成\n'; editor(text, true);
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  instance.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
  for (const type of ['pointerdown', 'pointerup', 'click']) instance.view.contentDOM.dispatchEvent(new MouseEvent(type, { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  instance.view.dispatch(instance.state.replaceSelection('手机正文'));
  expect(instance.text).toContain('- [ ] 任务\n\n手机正文');
  expect(instance.text.endsWith('# 归档\n\n- [x] 完成\n')).toBe(true);
});

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
  ['正文\n\n# 归档\n\n- [x] 完成\n', '正文\n\n\n# 归档\n\n- [x] 完成\n'],
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
  ['- [ ] 任务\n\n# 归档\n\n- [x] 完成\n', '- [ ] 任务\n\n\n# 归档\n\n- [x] 完成\n'],
])('点击可见列表下方创建带分隔的空段落：%j', (text, expected) => {
  editor(text);
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  instance.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
  const click = () => instance.view.contentDOM.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  click();
  expect(instance.text).toBe(expected);
  expect(instance.state.selection.main.head).toBe(expected.includes('# 归档') ? expected.indexOf('# 归档') - 1 : expected.length);
  click();
  expect(instance.text).toBe(expected);
  instance.view.dispatch(instance.state.replaceSelection('正文'));
  // 空段落输入正文后，布局整理会保留活动正文与归档标题之间的分隔空行。
  expect(instance.text).toBe(expected.replace('- [ ] 任务\n\n', '- [ ] 任务\n\n正文').replace('\n# 归档', '\n\n# 归档'));
  expect(hiddenContentRanges(instance.state).some(range => instance.state.selection.main.head > range.from && instance.state.selection.main.head < range.to)).toBe(false);
});

it('点击归档前的无归属空行补出可编辑空段落，光标与输入落在同一行', () => {
  const text = '- [ ] 任务\n\n11\n\n# 归档\n\n- [x] 完成';
  editor(text);
  const lines = instance.view.contentDOM.querySelectorAll('.cm-line');
  const emptyLine = lines[lines.length - 1];
  expect(emptyLine.textContent?.trim()).toBeFalsy();
  expect(emptyLine.getAttribute('data-empty-paragraph-from')).toBeNull();
  emptyLine.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  // 边界空行没有段落归属，点击后必须补出真实的空段落，光标才能画在输入将要落下的位置。
  const paragraph = paragraphLayout(instance.state).paragraphs.find(entry => entry.from === instance.state.selection.main.head);
  expect(paragraph?.kind).toBe('empty');
  expect(instance.state.selection.main.head).toBeLessThan(instance.text.indexOf('# 归档'));
  instance.view.dispatch(instance.state.replaceSelection('Z'));
  expect(instance.text.indexOf('Z')).toBeLessThan(instance.text.indexOf('# 归档'));
  expect(instance.view.contentDOM.textContent).toContain('Z');
  expect(instance.view.contentDOM.textContent).not.toContain('完成');
});

it('点击末尾边界行与更下方留白得到相同结果', () => {
  const text = '- [ ] 任务\n\n11\n\n# 归档\n\n- [x] 完成';
  const read = () => ({ text: instance.text, head: instance.state.selection.main.head });
  editor(text);
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  instance.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
  const lines = instance.view.contentDOM.querySelectorAll('.cm-line');
  lines[lines.length - 1].dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  const viaLine = read();

  editor(text);
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  instance.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
  instance.view.contentDOM.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  const viaPadding = read();

  expect(viaLine).toEqual(viaPadding);
  // 已经补出空段落后，再次点击更下方只复用同一行。
  const stable = instance.text;
  instance.view.contentDOM.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  expect(instance.text).toBe(stable);
});

it('最后一行已是空行时点击下方不新增额外空行', () => {
  const text = '- [ ] 任务\n\n\n# 归档\n\n- [x] 完成';
  editor(text);
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  instance.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
  for (let count = 0; count < 3; count++) instance.view.contentDOM.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  expect(instance.text).toBe(text);
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

/** 点击路径可能先补齐正文，再调用 focusAt；两者都请求滚动会让视口先跳一次再动画。 */
function scrollRequests(dispatch: ReturnType<typeof vi.spyOn>): { nearest: number; centers: number } {
  const calls = dispatch.mock.calls.map(([spec]) => spec as TransactionSpec);
  return {
    nearest: calls.filter(spec => spec.scrollIntoView === true).length,
    centers: calls.flatMap(spec => spec.effects ? Array.isArray(spec.effects) ? spec.effects : [spec.effects] : [])
      .filter(effect => (effect.value as { y?: string } | null)?.y === 'center').length,
  };
}

it('点击空任务只发起一次居中导航滚动', () => {
  const text = '- [ ] \n\n- [ ] 后'; editor(text);
  const item = instance.model.tasks[0];
  const marker = instance.view.dom.querySelector<HTMLElement>(`[data-list-marker="${item.from}"]`)!;
  marker.getBoundingClientRect = () => new DOMRect(10, 10, 17, 20);
  instance.focusAt(text.length);
  const dispatch = vi.spyOn(instance.view, 'dispatch');
  marker.closest('.cm-line')!.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, clientY: 20, bubbles: true, cancelable: true }));
  expect(scrollRequests(dispatch)).toEqual({ nearest: 0, centers: 1 });
  expect(instance.state.selection.main.head).toBe(item.contentFrom);
  expect(instance.text).toBe(text);
});

it('点击底部留白补齐段落时只发起一次居中导航滚动', () => {
  editor('- [ ] 任务\n\n# 归档\n\n- [x] 完成\n');
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 30, bottom: 50 });
  instance.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
  const dispatch = vi.spyOn(instance.view, 'dispatch');
  instance.view.contentDOM.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 150, bubbles: true, cancelable: true }));
  expect(dispatch.mock.calls.some(([spec]) => !!(spec as TransactionSpec).changes)).toBe(true);
  expect(scrollRequests(dispatch)).toEqual({ nearest: 0, centers: 1 });
});
