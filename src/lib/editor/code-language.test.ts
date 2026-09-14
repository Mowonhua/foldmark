/** 文件职责：验证真实编辑器中的语言控件定位、围栏事务和键盘隔离。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';
import { setCodeLanguage } from './code-language';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const editors: EditorController[] = [];
function editor(text: string): EditorController {
  const parent = document.createElement('div'); document.body.append(parent);
  const result = new EditorController(parent, { text, mode: 'todo', onChange: () => {} });
  editors.push(result); return result;
}
afterEach(() => { for (const instance of editors.splice(0)) instance.destroy(); document.body.replaceChildren(); });

it('导入的闭合空围栏保持空框，首次点击才创建正文行', () => {
  const source = '正文\n\n```ts\n```';
  const instance = editor(source);
  expect(instance.text).toBe(source);
  expect(instance.view.contentDOM.textContent).not.toContain('```');
  const empty = instance.view.dom.querySelector<HTMLElement>('[aria-label="空代码块"]')!;
  expect(empty).not.toBeNull();
  empty.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  expect(instance.text).toBe('正文\n\n```ts\n\n```\n\n');
  expect(instance.state.doc.lineAt(instance.state.selection.main.head).text).toBe('');
  expect(instance.view.dom.querySelector('input[aria-label="代码块语言"]')).not.toBeNull();
  expect(instance.view.contentDOM.textContent).not.toContain('```');
});

it('仅编辑代码时在框外显示语言输入，离开代码后隐藏且不显示围栏源码', () => {
  const source = '正文\n\n```ts\nconst x = 1;\n```\n\n末尾';
  const instance = editor(source);
  expect(instance.view.dom.querySelector('input[aria-label="代码块语言"]')).toBeNull();
  expect(instance.view.dom.querySelector('.fm-code-language')).toBeNull();
  const lineCount = instance.view.contentDOM.querySelectorAll('.cm-line').length;
  instance.focusAt(source.indexOf('const'));
  expect(instance.view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(lineCount);
  const input = instance.view.dom.querySelector<HTMLInputElement>('input[aria-label="代码块语言"]')!;
  expect(input).not.toBeNull();
  expect(input.closest('.fm-code-line')).toBeNull();
  expect(instance.view.contentDOM.textContent).not.toContain('```');
  expect(input.value).toBe('ts');
  input.focus(); input.value = 'python';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(instance.text).toBe(source.replace('```ts', '```python'));
  instance.undo(); expect(instance.text).toBe(source);
  instance.focusAt(source.length);
  expect(instance.view.dom.querySelector('input[aria-label="代码块语言"]')).toBeNull();
  expect(instance.view.dom.querySelector('.fm-code-language')).toBeNull();
});

it('失焦保留修改、Esc 恢复本次编辑，输入中的撤销不会触发正文撤销', () => {
  const source = '正文\n\n```\ncode\n```';
  const instance = editor(source); instance.focusAt(source.indexOf('code'));
  let input = instance.view.dom.querySelector<HTMLInputElement>('input')!;
  input.focus(); input.value = 'c++'; input.dispatchEvent(new Event('change', { bubbles: true }));
  expect(instance.text).toBe(source.replace('```\n', '```c++\n'));
  instance.view.focus();
  input = instance.view.dom.querySelector<HTMLInputElement>('input')!;
  input.focus(); input.value = 'rust';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  expect(instance.text).toBe(source.replace('```\n', '```c++\n'));
  input = instance.view.dom.querySelector<HTMLInputElement>('input')!;
  input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  expect(instance.text).toBe(source.replace('```\n', '```c++\n'));
});

it('连续输入即时写回并保留输入框焦点，点击正文无需 change 事件也不丢语言', () => {
  const source = '正文\n\n```\ncode\n```\n\n末尾';
  const instance = editor(source); instance.focusAt(source.indexOf('code'));
  const input = instance.view.dom.querySelector<HTMLInputElement>('input')!;
  input.focus();
  for (const value of ['r', 'ru', 'rus', 'rust']) {
    input.value = value; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    expect(instance.view.dom.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(instance.text).toBe(source.replace('```\n', `\`\`\`${value}\n`));
  }
  instance.focusAt(instance.text.length);
  expect(instance.text).toBe(source.replace('```\n', '```rust\n'));
  instance.undo(); expect(instance.text).toBe(source);
});

it('语言编辑保留其他信息并拒绝换行、围栏注入及只读文档', () => {
  const source = '正文\n\n```ts title="example"\ncode\n```';
  const instance = editor(source); const from = source.indexOf('```');
  expect(setCodeLanguage(instance.view, from, 'c#')).toBe(true);
  expect(instance.text).toBe(source.replace('ts title', 'c# title'));
  for (const value of ['ts\n```', 'foo bar', 'a`b', 'a~b']) expect(setCodeLanguage(instance.view, from, value)).toBe(false);
  expect(instance.text).toBe(source.replace('ts title', 'c# title'));
  expect(setCodeLanguage(instance.view, 0, 'rust')).toBe(false);
  instance.setMode('archive');
  expect(setCodeLanguage(instance.view, from, 'rust')).toBe(false);
  expect(instance.view.dom.querySelector('input[aria-label="代码块语言"]')).toBeNull();
});
