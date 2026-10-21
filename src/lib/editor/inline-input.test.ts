/** 文件职责：验证行内格式边界的输入法编辑不会破坏正文 DOM 或后续编辑能力。 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorController } from './index';
import { markdownActionEnabled, runMarkdownAction } from './markdown-actions';
import { taskEnter } from './commands';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const editors: EditorController[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren(); });

describe('行内格式边界输入', () => {
  it.each([['strike', '~~'], ['bold', '**'], ['italic', '*'], ['inlineCode', '`']] as const)('%s 闭标记后输入括号时保留正文与输入节点，提交后仍可编辑', async (action, mark) => {
    const editor = new EditorController(document.body.appendChild(document.createElement('div')), {
      text: '- [ ] 示例任务段落', mode: 'todo', onChange: () => {},
    });
    editors.push(editor);
    editor.view.dispatch({ selection: { anchor: 6, head: editor.text.length } });
    runMarkdownAction(editor.view, action);
    editor.focusAt(editor.text.length);
    const content = editor.view.contentDOM;
    const end = editor.view.domAtPos(editor.text.length);
    expect(end.node.nodeType).toBe(Node.TEXT_NODE);
    const closing = end.node as Text;
    content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    closing.appendData('（');
    document.getSelection()!.collapse(closing, closing.length);
    content.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '（', isComposing: true, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    const formatted = `- [ ] ${mark}示例任务段落${mark}`;
    expect(editor.text).toBe(formatted + '（）');
    expect(content.textContent).toContain(`${mark}示例任务段落${mark}（）`);
    expect(closing.isConnected).toBe(true);
    content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '（' }));
    expect(editor.view.composing).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(content.textContent).not.toContain(`${mark}示例任务段落${mark}`);
    expect(markdownActionEnabled(editor.view, 'bold')).toBe(true);
    expect(taskEnter(editor.view)).toBe(true);
    expect(editor.text).toBe(formatted + '（\n\n- [ ] ）');
    editor.undo(); editor.undo();
    expect(editor.text).toBe(formatted);
    editor.redo();
    expect(editor.text).toBe(formatted + '（）');
  });

  it('行内标记只在光标命中时展开，离开标记后隐藏，重新进入可继续编辑', () => {
    const editor = new EditorController(document.body.appendChild(document.createElement('div')), {
      text: '- [ ] ~~主任务~~ 后文\n\n  - [ ] 子任务', mode: 'todo', onChange: () => {},
    });
    editors.push(editor);
    const content = editor.view.contentDOM;
    editor.focusAt(10);
    expect(content.textContent).toContain('~~主任务~~ 后文');
    editor.focusAt(editor.text.indexOf('后文'));
    expect(content.textContent).toContain('主任务 后文');
    expect(content.textContent).not.toContain('~~');
    editor.focusAt(editor.text.length);
    expect(content.textContent).not.toContain('~~');
    editor.focusAt(10);
    expect(content.textContent).toContain('~~主任务~~ 后文');
  });

  it('同一行有多个行内标记时只展开光标命中的那一组', () => {
    const editor = new EditorController(document.body.appendChild(document.createElement('div')), {
      text: '- [ ] ~~删除~~ 与 **加粗** 和 `代码`', mode: 'todo', onChange: () => {},
    });
    editors.push(editor);
    const content = editor.view.contentDOM;
    editor.focusAt(editor.text.indexOf('加粗'));
    expect(content.textContent).toContain('删除 与 **加粗** 和 代码');
    expect(content.textContent).not.toContain('~~');
    expect(content.textContent).not.toContain('`');
    editor.focusAt(editor.text.indexOf('删除'));
    expect(content.textContent).toContain('~~删除~~ 与 加粗 和 代码');
    expect(content.textContent).not.toContain('**');
    expect(content.textContent).not.toContain('`');
    editor.focusAt(editor.text.indexOf('代码'));
    expect(content.textContent).toContain('删除 与 加粗 和 `代码`');
    expect(content.textContent).not.toContain('~~');
    expect(content.textContent).not.toContain('**');
  });
});
