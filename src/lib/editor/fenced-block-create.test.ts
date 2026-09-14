/** 文件职责：验证围栏草稿在回车时创建块，以及块后的可继续输入行。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';
import { fencedBlocks } from './fenced-blocks';
import { draftFencedBlocksField } from './fenced-block-state';
import { paragraphLayout } from './paragraphs';
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });
function editor(text: string) { instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} }); }
function key(key: string, shiftKey = false) { instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })); }
function type(text: string) {
  const { from, to } = instance.state.selection.main;
  instance.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' });
}

it.each(['```', '$$'])('%s 输入后保持草稿，回车才建块并在后面留下可输入行', mark => {
  editor('- [ ] A\n  原有正文\n- [ ] B'); instance.focusAt(7); key('Enter', true); type(mark);
  const before = instance.text, cursor = instance.state.selection.main.head;
  expect(instance.state.field(draftFencedBlocksField)).toHaveLength(1);
  expect(instance.view.contentDOM.querySelector('.fm-code-line, .fm-math-block')).toBeNull();
  expect(instance.state.selection.main.head).toBe(cursor);
  key('Enter');
  expect(instance.state.field(draftFencedBlocksField)).toEqual([]);
  expect(instance.text).toBe('- [ ] A\n  ' + mark + '\n  \n  ' + mark + '\n\n  \n\n  原有正文\n- [ ] B');
  expect(instance.view.contentDOM.querySelector('.fm-code-line')).not.toBeNull();
  instance.undo(); expect(instance.text).toBe(before); expect(instance.state.selection.main.head).toBe(cursor);
  expect(instance.view.contentDOM.querySelector('.fm-code-line, .fm-math-block')).toBeNull();
});

it.each(['```', '$$'])('文末 %s 块保留同容器空行，方向键可移出后继续输入', mark => {
  editor('- [ ] A'); instance.focusAt(7); key('Enter', true); type(mark); key('Enter');
  expect(instance.text).toBe('- [ ] A\n  ' + mark + '\n  \n  ' + mark + '\n\n  ');
  type('x');
  const block = fencedBlocks(instance.state)[0];
  instance.focusAt(block.bodyTo); key('ArrowRight');
  expect(instance.state.selection.main.head).toBeGreaterThan(block.to);
  type('后续');
  expect(instance.text).toContain(mark + '\n\n  后续');
  expect(paragraphLayout(instance.state).paragraphs.at(-1)?.kind).toBe('text');
});

it.each(['```', '$$'])('块后空行可点击定位到结构缩进之后：%s', mark => {
  editor('- [ ] A\n- [ ] B'); instance.focusAt(7); key('Enter', true); type(mark); key('Enter');
  const paragraph = paragraphLayout(instance.state).paragraphs.find(paragraph => paragraph.kind === 'empty')!;
  instance.focusAt(0);
  const line = instance.view.contentDOM.querySelector<HTMLElement>(`[data-empty-paragraph-from="${paragraph.from}"]`)!;
  expect(line).not.toBeNull();
  line.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 200, bubbles: true, cancelable: true }));
  expect(instance.state.selection.main.head).toBe(paragraph.contentFrom);
  type('outside'); expect(instance.text).toContain(mark + '\n\n  outside\n\n- [ ] B');
});

it.each(['```', '$$'])('复用已有 %s 块后正文时只补缺失分隔，不重复新增空行', mark => {
  const source = '- [ ] A\n  ' + mark + '\n  x\n  ' + mark + '\n  外部';
  editor(source); instance.focusAt(source.indexOf('x') + 1); key('Enter');
  expect(instance.text).toBe('- [ ] A\n  ' + mark + '\n  x\n  \n  ' + mark + '\n\n  外部');
  key('Enter');
  expect(instance.text).toBe('- [ ] A\n  ' + mark + '\n  x\n  \n  \n  ' + mark + '\n\n  外部');
});
