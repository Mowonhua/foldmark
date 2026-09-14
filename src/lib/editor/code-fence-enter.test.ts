/**
 * 文件职责：验证代码围栏 Enter 命令在真实编辑器中的输入和撤销契约。
 * 定义范围：围栏补全、光标位置与默认输入的接管边界。
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';
import { codeFenceEnter, taskKeymap } from './commands';
import { EditorController, type EditorOptions } from './index';
import { paragraphLayout } from './paragraphs';

// jsdom 无布局能力；事务测试不依赖几何信息。
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const editors: EditorController[] = [];
function editor(text: string, mode: EditorOptions['mode'] = 'todo'): EditorController {
  const parent = document.createElement('div');
  document.body.append(parent);
  const instance = new EditorController(parent, { text, mode, onChange: () => {} });
  editors.push(instance);
  instance.focusAt(instance.state.doc.length);
  return instance;
}
afterEach(() => { for (const instance of editors.splice(0)) instance.destroy(); document.body.replaceChildren(); });

describe('代码围栏自动闭合', () => {
  it('真实 Enter 键先执行围栏命令，并保留任务正文缩进', () => {
    const instance = editor('- [ ] 示例\n  ```js');
    instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(instance.text).toBe('- [ ] 示例\n  ```js\n  \n  ```\n\n  ');
    expect(instance.state.doc.lineAt(instance.state.selection.main.head).number).toBe(3);
    instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(instance.state.selection.main.head).toBe(instance.text.length);
    expect(paragraphLayout(instance.state).paragraphs.at(-1)).toMatchObject({ kind: 'empty', indent: '  ' });
    const at = instance.state.selection.main.head;
    instance.view.dispatch({ changes: { from: at, insert: '后续' }, selection: { anchor: at + 2 }, userEvent: 'input.type' });
    expect(instance.text).toBe('- [ ] 示例\n  ```js\n  \n  ```\n\n  后续');
  });
  it.each(['todo', 'source'] as const)('%s 模式回车补齐代码行与闭围栏，单次撤销恢复开围栏', mode => {
    const instance = editor('```typescript', mode);
    expect(taskKeymap.find(binding => binding.key === 'Enter')!.run!(instance.view)).toBe(true);
    expect(instance.text).toBe('```typescript\n\n```' + (mode === 'todo' ? '\n\n' : ''));
    expect(instance.state.selection.main.head).toBe('```typescript\n'.length);
    expect(instance.undo()).toBe(true);
    expect(instance.text).toBe('```typescript');
  });
  it.each(['  ````js', '  ~~~python'])('保留围栏 %s 的缩进和长度', opening => {
    const instance = editor(opening);
    expect(codeFenceEnter(instance.view)).toBe(true);
    const marker = opening.trim().match(/^(`+|~+)/)![0];
    expect(instance.text).toBe(`${opening}\n  \n  ${marker}\n\n  `);
    expect(instance.state.selection.main.head).toBe(opening.length + 3);
    expect(paragraphLayout(instance.state).paragraphs.at(-1)).toMatchObject({ kind: 'empty', contentFrom: instance.text.length });
  });
  it('CRLF 输入规范化后使用 CodeMirror 文档坐标定位光标', () => {
    const instance = editor('正文\r\n\r\n```');
    expect(codeFenceEnter(instance.view)).toBe(true);
    expect(instance.text).toBe('正文\n\n```\n\n```\n\n');
    expect(instance.state.doc.lineAt(instance.state.selection.main.head).number).toBe(4);
    expect(instance.state.selection.main.head).toBe('正文\n\n```\n'.length);
  });
  it.each([
    ['```js\nexisting\n```', 5],
    ['````\n```', 8],
    ['inline ```', 10],
    ['    ```', 7],
    ['```js', 3],
    ['```js\n```', 9],
  ] as const)('不接管已有闭合、代码内标记或非开围栏末尾 %s', (text, position) => {
    const instance = editor(text);
    instance.focusAt(position);
    expect(codeFenceEnter(instance.view)).toBe(false);
    expect(instance.text).toBe(text);
  });
  it('归档、IME、非空选区和多光标保留默认行为', () => {
    const archive = editor('```', 'archive');
    expect(codeFenceEnter(archive.view)).toBe(false);
    const composing = editor('```');
    Object.defineProperty(composing.view, 'composing', { value: true });
    expect(codeFenceEnter(composing.view)).toBe(false);
    const selected = editor('```');
    selected.view.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(codeFenceEnter(selected.view)).toBe(false);
    const multiple = editor('```');
    multiple.view.setState(EditorState.create({ doc: '```', selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)]), extensions: [EditorState.allowMultipleSelections.of(true)] }));
    expect(codeFenceEnter(multiple.view)).toBe(false);
  });
});
