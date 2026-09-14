/** 文件职责：通过实际编辑器按键验证代码与公式共用的块内输入和空块删除。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';
import { paragraphLayout } from './paragraphs';
import { fencedBlocks } from './fenced-blocks';
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });
function editor(text: string) { instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} }); }
function key(key: string, shiftKey = false) { instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })); }
function exitParagraph() {
  const block = fencedBlocks(instance.state)[0];
  const exit = paragraphLayout(instance.state).paragraphs.find(paragraph => paragraph.kind === 'empty' && paragraph.from > block.to)!;
  expect(exit).toBeDefined();
  expect(exit.contentFrom).toBe(exit.to);
  return exit;
}

it.each(['```', '$$'])('空 %s 块按一次 Backspace 删除整块并可撤销', mark => {
  const text = '前\n\n' + mark + '\n\n' + mark + '\n\n后';
  editor(text); const cursor = text.indexOf(mark) + mark.length + 1;
  instance.focusAt(cursor); key('Backspace');
  expect(instance.text).toBe('前\n\n后');
  expect(instance.undo()).toBe(true); expect(instance.text).toBe(text);
  expect(instance.state.selection.main.head).toBe(cursor);
});

it.each(['```', '$$'])('列表内 %s 块回车自动闭合，连续输入保持结构缩进', mark => {
  const start = '- [ ] 前\n  ' + mark;
  editor(start); instance.focusAt(start.length); key('Enter');
  expect(instance.text).toBe(start + '\n  \n  ' + mark + '\n\n  ');
  key('Enter');
  expect(instance.text).toBe(start + '\n  \n  \n  ' + mark + '\n\n  ');
  const pos = instance.state.selection.main.head;
  instance.view.dispatch({ changes: { from: pos, insert: 'x' }, selection: { anchor: pos + 1 }, userEvent: 'input.type' });
  expect(instance.text).toBe(start + '\n  \n  x\n  ' + mark + '\n\n  ');
  const exit = exitParagraph();
  expect(exit.indent).toBe('  ');
  key('ArrowRight');
  expect(instance.state.selection.main.head).toBe(exit.contentFrom);
  instance.view.dispatch({ changes: { from: exit.contentFrom, insert: '外部' }, selection: { anchor: exit.contentFrom + 2 }, userEvent: 'input.type' });
  expect(instance.text).toBe(start + '\n  \n  x\n  ' + mark + '\n\n  外部');
});

it.each(['```', '$$'])('已有段落分隔前输入 %s 后，光标保留在开围栏且能回车补全', mark => {
  editor('- [ ] A\n\n- [ ] B'); instance.focusAt(7); key('Enter', true);
  const at = instance.state.selection.main.head;
  instance.view.dispatch({ changes: { from: at, insert: mark }, selection: { anchor: at + mark.length }, userEvent: 'input.type' });
  expect(instance.state.selection.main.head).toBe(at + mark.length);
  key('Enter');
  expect(instance.text).toBe('- [ ] A\n  ' + mark + '\n  \n  ' + mark + '\n\n  \n\n- [ ] B');
  expect(exitParagraph().indent).toBe('  ');
});

it.each(['```', '$$'])('创建 %s 块时保留后面的分隔与已有空段', mark => {
  const source = '- [ ] A\n  ' + mark + '\n\n\n\n- [ ] B';
  editor(source); instance.focusAt(source.indexOf(mark) + mark.length); key('Enter');
  expect(instance.text).toBe('- [ ] A\n  ' + mark + '\n  \n  ' + mark + '\n\n  \n\n\n\n- [ ] B');
  expect(exitParagraph().indent).toBe('  ');
  expect(paragraphLayout(instance.state).paragraphs.filter(paragraph => paragraph.kind === 'empty')).toHaveLength(2);
});

it.each(['```', '$$'])('编辑已有 %s 块时补齐与下一任务的分隔，撤销恢复原布局', mark => {
  const source = '- [ ] A\n  ' + mark + '\n  x\n  ' + mark + '\n- [ ] B';
  editor(source); const cursor = source.indexOf('x') + 1; instance.focusAt(cursor); key('Enter');
  expect(instance.text).toBe('- [ ] A\n  ' + mark + '\n  x\n  \n  ' + mark + '\n\n  \n\n- [ ] B');
  expect(exitParagraph().indent).toBe('  ');
  instance.undo(); expect(instance.text).toBe(source); expect(instance.state.selection.main.head).toBe(cursor);
});

it('单行公式展开时补齐后方分隔', () => {
  editor('$$x$$\n后'); instance.focusAt(3); key('Enter');
  expect(instance.text).toBe('$$\nx\n\n$$\n\n\n\n后');
  expect(exitParagraph().indent).toBe('');
});

it.each(['```', '$$'])('空闭合 %s 块激活新增正文时也补齐后方分隔', mark => {
  editor(mark + '\n' + mark + '\n后'); instance.focusAt(instance.text.length);
  instance.view.contentDOM.querySelector('.fm-empty-code')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  expect(instance.text).toBe(mark + '\n\n' + mark + '\n\n\n\n后');
  expect(exitParagraph().indent).toBe('');
});

it.each(['```', '$$'])('源码模式补全 %s 不额外整理相邻段落', mark => {
  editor('- [ ] A\n  ' + mark + '\n- [ ] B'); instance.setMode('source');
  instance.focusAt(instance.text.indexOf(mark) + mark.length); key('Enter');
  expect(instance.text).toBe('- [ ] A\n  ' + mark + '\n  \n  ' + mark + '\n- [ ] B');
});

it('块公式激活后隐藏定界符，在框内直接编辑，失焦恢复排版', () => {
  editor('$$\nx^2\n$$\n\n后'); instance.focusAt(instance.text.length);
  const math = instance.view.contentDOM.querySelector('.fm-math-block')!;
  math.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  expect(instance.state.selection.main.head).toBe(3);
  expect(instance.view.contentDOM.querySelector('.fm-math-edit-line')?.textContent).toBe('x^2');
  expect(instance.view.contentDOM.querySelectorAll('.fm-code-fence')).toHaveLength(2);
  key('Enter'); expect(instance.text).toBe('$$\n\nx^2\n$$\n\n后');
  instance.focusAt(instance.text.length);
  expect(instance.view.contentDOM.querySelector('.fm-math-block .katex')).not.toBeNull();
});

it.each(['```', '$$'])('Shift Enter 创建的空 %s 块删除后保留外部可输入段落', mark => {
  editor('- [ ] A\n- [ ] B'); instance.focusAt(7); key('Enter', true);
  const at = instance.state.selection.main.head;
  instance.view.dispatch({ changes: { from: at, insert: mark }, selection: { anchor: at + mark.length }, userEvent: 'input.type' });
  key('Enter', true); key('Backspace');
  expect(instance.text).toBe('- [ ] A\n\n  \n\n- [ ] B');
  expect(paragraphLayout(instance.state).paragraphs).toHaveLength(3);
  expect(instance.view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(3);
  const exit = paragraphLayout(instance.state).paragraphs[1];
  instance.focusAt(exit.contentFrom);
  instance.view.dispatch({ changes: { from: exit.contentFrom, insert: '继续' }, selection: { anchor: exit.contentFrom + 2 }, userEvent: 'input.type' });
  expect(instance.text).toBe('- [ ] A\n\n  继续\n\n- [ ] B');
  expect(fencedBlocks(instance.state)).toHaveLength(0);
});

it('单行公式点击后直接编辑，Enter 展开为多行公式并可撤销', () => {
  editor('$$x+y$$\n\n后'); instance.focusAt(instance.text.length);
  instance.view.contentDOM.querySelector('.fm-math-block')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  expect(instance.text).toBe('$$x+y$$\n\n后');
  instance.focusAt(3); key('Enter');
  expect(instance.text).toBe('$$\nx\n+y\n$$\n\n\n\n后');
  expect(exitParagraph().indent).toBe('');
  expect(instance.undo()).toBe(true);
  expect(instance.text).toBe('$$x+y$$\n\n后');
});

it.each(['```\n```', '$$\n$$'])('无正文行的空块控件可点击编辑并退格删除：%s', source => {
  editor(source + '\n\n后'); instance.focusAt(instance.text.length);
  const block = instance.view.contentDOM.querySelector('.fm-empty-code')!;
  expect(block).not.toBeNull();
  block.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  key('Backspace'); expect(instance.text).toBe('\n\n后');
  expect(paragraphLayout(instance.state).paragraphs[0]).toMatchObject({ kind: 'empty', contentFrom: 0 });
  expect(instance.state.selection.main.head).toBe(0);
  instance.view.dispatch({ changes: { from: 0, insert: '前续' }, selection: { anchor: 2 }, userEvent: 'input.type' });
  expect(instance.text).toBe('前续\n\n后');
});
