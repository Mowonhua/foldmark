/** 文件职责：验证空任务正文的指针定位，不改写文档或接管任务控件手势。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });
function editor(text: string) {
  instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} });
}

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
