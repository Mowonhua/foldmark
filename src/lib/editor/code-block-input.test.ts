/** 文件职责：通过真实结构按键复现列表正文中新建代码块的路径差异。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';
import { paragraphLayout } from './paragraphs';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });
function editor(source: string) {
  instance = new EditorController(document.body, { text: source, mode: 'todo', onChange: () => {} });
  instance.focusAt(source.length);
}
function key(name: string, shiftKey = false, ctrlKey = false) {
  instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, ctrlKey, bubbles: true, cancelable: true }));
}
/** jsdom 不产生浏览器默认文字输入；文字事务使用当前选区，结构操作始终发送 keydown。 */
function type(text: string) {
  const { from, to } = instance.state.selection.main;
  instance.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' });
}
function blocks(name: string) {
  const result: { from: number; to: number; source: string }[] = [];
  instance.model.tree.iterate({ enter(node) {
    if (node.name === name) result.push({ from: node.from, to: node.to, source: instance.text.slice(node.from, node.to) });
  } });
  return result;
}

it.each(['shift-enter', 'new-task-backspace', 'body-enter'] as const)('%s 产生标准列表正文缩进时，围栏自动闭合并包含代码', path => {
  editor(path === 'body-enter' ? '- [ ] fds\n\n  正文' : '- [ ] fds');
  if (path === 'shift-enter') key('Enter', true);
  else {
    key('Enter');
    if (path === 'new-task-backspace') key('Backspace');
  }
  type('```'); key('Enter'); type('int i');
  expect(blocks('CodeBlock')).toEqual([]);
  expect(blocks('FencedCode')).toHaveLength(1);
  expect(blocks('FencedCode')[0].source).toContain('int i');
  expect(blocks('FencedCode')[0].source.endsWith('```')).toBe(true);
});

it('任务内两次 Shift Enter 创建闭合围栏，输入保持在代码正文', () => {
  editor('- [ ] fds');
  key('Enter', true); type('```'); key('Enter', true); type('int i');
  expect(instance.text).toBe('- [ ] fds\n  ```\n  int i\n  ```\n\n  ');
  expect(blocks('FencedCode')).toHaveLength(1);
  expect(blocks('FencedCode')[0].source).toBe('```\n  int i\n  ```');
  expect([...instance.view.contentDOM.querySelectorAll('.fm-code-line')].some(line => line.textContent?.includes('int i'))).toBe(true);
  expect(instance.view.contentDOM.textContent).not.toContain('```');
  key('ArrowRight');
  expect(instance.state.selection.main.head).toBe(instance.text.length);
  type('块外');
  expect(instance.text).toBe('- [ ] fds\n  ```\n  int i\n  ```\n\n  块外');
  expect(blocks('FencedCode')[0].source).not.toContain('块外');
});

it.each(['enter', 'shift-enter', 'ctrl-enter'])('代码块内连续 %s 只增加代码空行，不插入段落分隔', action => {
  editor('- [ ] fds'); key('Enter', true); type('```'); key('Enter', true);
  key('Enter', action === 'shift-enter', action === 'ctrl-enter');
  key('Enter', action === 'shift-enter', action === 'ctrl-enter');
  type('int i');
  expect(instance.text).toBe('- [ ] fds\n  ```\n  \n  \n  int i\n  ```\n\n  ');
  expect(blocks('FencedCode')).toHaveLength(1);
  expect(instance.view.contentDOM.querySelectorAll('.fm-code-line')).toHaveLength(3);
  expect(instance.state.selection.main.head).toBe(instance.text.indexOf('int i') + 5);
  expect(paragraphLayout(instance.state).paragraphs.filter(paragraph => paragraph.kind === 'empty')).toHaveLength(1);
});
