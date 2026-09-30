/** 文件职责：验证 Markdown 菜单动作的局部编辑、安全边界和撤销契约。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { EditorController } from './index';
import { markdownActionActive, markdownActionEnabled, runMarkdownAction, type MarkdownAction } from './markdown-actions';
import { fencedBlocks } from './fenced-blocks';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const editors: EditorController[] = [];
function setup(text: string, from = 0, to = from) {
  const editor = new EditorController(document.body.appendChild(document.createElement('div')), { text, mode: 'todo', onChange: () => {} });
  editors.push(editor); editor.view.dispatch({ selection: { anchor: from, head: to } });
  return editor;
}
afterEach(() => { vi.restoreAllMocks(); for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren(); });

describe('局部 Markdown 菜单动作', () => {
  it.each(['heading2', 'taskList', 'codeBlock', 'mathBlock', 'horizontalRule'] as const)('段落之间的真实空行允许 %s，不覆盖前后正文', action => {
    const editor = setup('before\n\nafter', 7);
    expect(markdownActionEnabled(editor.view, action)).toBe(true);
    expect(runMarkdownAction(editor.view, action)).toBe(true);
    expect(editor.text.startsWith('before\n\n')).toBe(true);
    expect(editor.text.endsWith('\n\nafter')).toBe(true);
    editor.undo(); expect(editor.text).toBe('before\n\nafter');
  });
  it('分隔线可以插入任务正文并保留子项容器和撤销历史', () => {
    const editor = setup('- [ ] root\n  body\n  - child', 14);
    expect(markdownActionEnabled(editor.view, 'horizontalRule')).toBe(true);
    expect(runMarkdownAction(editor.view, 'horizontalRule')).toBe(true);
    expect(editor.text).toBe('- [ ] root\n  body\n\n  ---\n\n  - child');
    expect(editor.model.items[1].parentFrom).toBe(editor.model.items[0].from);
    editor.undo(); expect(editor.text).toBe('- [ ] root\n  body\n  - child');
  });
  it('插入分隔线不把局部文字选区当作整段替换', () => {
    const editor = setup('ordinary paragraph', 2, 8);
    expect(markdownActionEnabled(editor.view, 'horizontalRule')).toBe(true);
    expect(runMarkdownAction(editor.view, 'horizontalRule')).toBe(true);
    expect(editor.text).toBe('ordinary paragraph\n\n---');
  });
  it.each([['bold', '**'], ['italic', '*'], ['strike', '~~'], ['inlineCode', '`']] as const)('选区 %s 包裹后可取消，撤销恢复原文', (action, mark) => {
    const editor = setup('alpha beta', 0, 5);
    expect(runMarkdownAction(editor.view, action)).toBe(true);
    expect(editor.text).toBe(`${mark}alpha${mark} beta`);
    expect(markdownActionActive(editor.state, action)).toBe(true);
    expect(runMarkdownAction(editor.view, action)).toBe(true); expect(editor.text).toBe('alpha beta');
    expect(editor.undo()).toBe(true); expect(editor.text).toBe(`${mark}alpha${mark} beta`);
  });
  it('光标内取消 AST 格式，空光标创建成对标记并定位内部', () => {
    const editor = setup('**alpha**', 4);
    expect(runMarkdownAction(editor.view, 'bold')).toBe(true); expect(editor.text).toBe('alpha');
    expect(editor.state.selection.main.head).toBe(2);
    editor.setText(''); expect(runMarkdownAction(editor.view, 'bold')).toBe(true);
    expect(editor.text).toBe('****'); expect(editor.state.selection.main.head).toBe(2);
  });
  it('行内格式保留边界空白，拒绝修改标题语法标记', () => {
    const editor = setup(' alpha ', 0, 7);
    expect(runMarkdownAction(editor.view, 'bold')).toBe(true); expect(editor.text).toBe(' **alpha** ');
    expect(markdownActionActive(editor.state, 'bold')).toBe(true);
    const blank = setup('a   b', 1, 4);
    expect(markdownActionEnabled(blank.view, 'italic')).toBe(false);
    const heading = setup('# title', 0, 7);
    expect(runMarkdownAction(heading.view, 'bold')).toBe(false); expect(heading.text).toBe('# title');
  });
  it('行内代码避开选中文字里的反引号，链接选中地址待输入', () => {
    const editor = setup('a`b', 0, 3);
    expect(runMarkdownAction(editor.view, 'inlineCode')).toBe(true); expect(editor.text).toBe('``a`b``');
    const linked = setup('名称', 0, 2);
    expect(runMarkdownAction(linked.view, 'link')).toBe(true); expect(linked.text).toBe('[名称](https://)');
    expect(linked.state.sliceDoc(linked.state.selection.main.from, linked.state.selection.main.to)).toBe('https://');
    const boundary = setup('`alpha', 0, 6);
    expect(runMarkdownAction(boundary.view, 'inlineCode')).toBe(true); expect(boundary.text).toBe('`` `alpha ``');
    expect(runMarkdownAction(boundary.view, 'inlineCode')).toBe(true); expect(boundary.text).toBe('`alpha');
  });
  it('段落转换替换完整标题和列表标记，保留后代原文', () => {
    const editor = setup('# title', 3);
    expect(runMarkdownAction(editor.view, 'heading3')).toBe(true); expect(editor.text).toBe('### title');
    expect(runMarkdownAction(editor.view, 'paragraph')).toBe(true); expect(editor.text).toBe('title');
    editor.setText('- root\n  - child\n    detail'); editor.view.dispatch({ selection: { anchor: 3 } });
    expect(runMarkdownAction(editor.view, 'taskList')).toBe(true);
    expect(editor.text).toBe('- [ ] root\n  - child\n    detail');
    expect(editor.model.items[1].parentFrom).toBe(editor.model.items[0].from);
    expect(markdownActionEnabled(editor.view, 'heading1')).toBe(false);
    expect(markdownActionEnabled(editor.view, 'orderedList')).toBe(false);
  });
  it('完整普通段落转引用、列表和 Setext 标题转正文', () => {
    const editor = setup('title\n===', 2);
    expect(runMarkdownAction(editor.view, 'paragraph')).toBe(true); expect(editor.text).toBe('title');
    expect(runMarkdownAction(editor.view, 'quote')).toBe(true); expect(editor.text).toBe('> title');
    expect(markdownActionEnabled(editor.view, 'heading1')).toBe(false);
    editor.setText('one\nsecond'); editor.view.dispatch({ selection: { anchor: 1 } });
    expect(runMarkdownAction(editor.view, 'bulletList')).toBe(true); expect(editor.text).toBe('- one\n  second');
    const indented = setup('  # title', 0, 9);
    expect(runMarkdownAction(indented.view, 'heading2')).toBe(true); expect(indented.text).toBe('  ## title');
  });
  it('代码与数学创建独立块，围栏避开正文并定位正文，撤销只撤本动作', () => {
    const editor = setup('before\n\na ``` b\n\nafter', 10);
    expect(runMarkdownAction(editor.view, 'codeBlock')).toBe(true);
    expect(editor.text).toBe('before\n\n````\na ``` b\n````\n\nafter');
    expect(editor.state.selection.main.head).toBe(fencedBlocks(editor.state)[0].bodyFrom);
    editor.undo(); expect(editor.text).toBe('before\n\na ``` b\n\nafter');
    editor.setText('x + y'); editor.view.dispatch({ selection: { anchor: 2 } });
    expect(runMarkdownAction(editor.view, 'mathBlock')).toBe(true); expect(editor.text).toBe('$$\nx + y\n$$');
  });
  it('列表首行插入代码作为该项正文，不拆标题或后代', () => {
    const editor = setup('- [ ] root\n  - child', 8);
    expect(runMarkdownAction(editor.view, 'codeBlock')).toBe(true);
    expect(editor.text).toBe('- [ ] root\n\n  ```\n  \n  ```\n\n  - child');
    expect(fencedBlocks(editor.state)[0].indent).toBe('  ');
  });
  it('列表多行正文转代码不重复容器缩进，IME 禁止提交', () => {
    const editor = setup('- root\n\n  one\n  two', 11);
    expect(runMarkdownAction(editor.view, 'codeBlock')).toBe(true);
    expect(editor.text).toBe('- root\n\n  ```\n  one\n  two\n  ```');
    expect(fencedBlocks(editor.state)[0].indent).toBe('  ');
    const composing = setup('text', 2);
    vi.spyOn(composing.view, 'composing', 'get').mockReturnValue(true);
    expect(runMarkdownAction(composing.view, 'bold')).toBe(false); expect(composing.text).toBe('text');
  });
  it('分隔线独立插入，结构范围复杂、隐藏交叉及字面块均拒绝', () => {
    const editor = setup('text', 2);
    expect(runMarkdownAction(editor.view, 'horizontalRule')).toBe(true); expect(editor.text).toBe('text\n\n---');
    for (const text of ['```\ncode\n```', '$$\nx\n$$', '<div>\nhtml\n</div>']) {
      editor.setText(text); editor.view.dispatch({ selection: { anchor: text.indexOf('\n') + 1 } });
      for (const action of ['bold', 'heading1', 'codeBlock'] as MarkdownAction[]) expect(markdownActionEnabled(editor.view, action)).toBe(false);
    }
    editor.setText('- [ ] first\n- [x] hidden\n- [ ] last');
    editor.view.dispatch({ selection: { anchor: 6, head: editor.text.length } });
    expect(runMarkdownAction(editor.view, 'bold')).toBe(false);
    editor.setText('one\n\ntwo'); editor.view.dispatch({ selection: { anchor: 1, head: 7 } });
    expect(runMarkdownAction(editor.view, 'heading1')).toBe(false);
  });
  it('归档、IME 和多选区禁用并保留正文', () => {
    const editor = setup('- [x] archived', 8); editor.setMode('archive');
    expect(runMarkdownAction(editor.view, 'bold')).toBe(false);
    editor.setText('one two'); editor.setMode('todo');
    editor.view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(4, 5)]) });
    expect(runMarkdownAction(editor.view, 'bold')).toBe(false); expect(editor.text).toBe('one two');
  });
  it('源码已完成任务保持复选框状态，复杂选区不拆容器', () => {
    const editor = setup('- [x] done'); editor.setMode('archive'); editor.toggleSource();
    editor.view.dispatch({ selection: { anchor: 8 } });
    expect(markdownActionActive(editor.state, 'taskList')).toBe(true);
    expect(runMarkdownAction(editor.view, 'taskList')).toBe(false); expect(editor.text).toBe('- [x] done');
    const partial = setup('ordinary paragraph', 2, 8);
    expect(runMarkdownAction(partial.view, 'codeBlock')).toBe(false);
    expect(runMarkdownAction(partial.view, 'heading1')).toBe(true); expect(partial.text).toBe('# ordinary paragraph');
  });
});
