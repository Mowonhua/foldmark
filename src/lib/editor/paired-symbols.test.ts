/** 文件职责：验证输入法一次提交成对符号后光标落在符号中心，且不干扰普通输入。 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorController } from './index';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const editors: EditorController[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren(); });

function editor(text: string): EditorController {
  const instance = new EditorController(document.body.appendChild(document.createElement('div')), { text, mode: 'todo', onChange: () => {} });
  editors.push(instance);
  return instance;
}

/**
 * 模拟输入法一次提交：把整段文本写进 DOM 并派发普通 input 事件，再让编辑器读取这次 DOM 变更。
 * caret 是相对提交文本起点的光标位置，默认停在文本末尾，用于区分输入法是否已经居中。
 * composing 为真时前后包上组合会话事件；中文输入法提交成对标点通常发生在组合会话内。
 */
async function commit(instance: EditorController, inserted: string, caret = inserted.length, composing = false): Promise<void> {
  instance.focusAt(instance.text.length);
  const end = instance.view.domAtPos(instance.text.length);
  const node = end.node as Text;
  if (composing) instance.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  node.appendData(inserted);
  document.getSelection()!.collapse(node, node.length - inserted.length + caret);
  instance.view.contentDOM.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: inserted, bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
}

describe('输入法成对符号光标居中', () => {
  it.each([['（）'], ['()'], ['【】'], ['[]'], ['{}'], ['<>'], ['［］'], ['｛｝'], ['〈〉'], ['《》'], ['〔〕'], ['〖〗'], ['「」'], ['『』'], ['""'], ["''"], ['“”'], ['‘’']])('整段提交 %s 后光标落在两符号之间', async inserted => {
    const instance = editor('- [ ] 任务');
    await commit(instance, inserted);
    expect(instance.text).toBe(`- [ ] 任务${inserted}`);
    expect(instance.state.selection.main.head).toBe('- [ ] 任务'.length + 1);
  });

  it('输入法组合会话中提交成对符号后光标同样落在两符号之间', async () => {
    const instance = editor('- [ ] 任务');
    await commit(instance, '（）', 2, true);
    expect(instance.text).toBe('- [ ] 任务（）');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务'.length + 1);
  });

  it('输入法已经居中时不改动选区，整对符号仍可一次撤销', async () => {
    const instance = editor('- [ ] 任务');
    await commit(instance, '（）', 1);
    expect(instance.text).toBe('- [ ] 任务（）');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务'.length + 1);
    expect(instance.undo()).toBe(true);
    expect(instance.text).toBe('- [ ] 任务');
  });

  /** 单个符号的补齐由 bracket-completion.test.ts 覆盖，这里只确认本扩展不改写非整对提交。 */
  it('非整对提交保持默认光标位置', async () => {
    for (const inserted of ['ab', '（（']) {
      const instance = editor('- [ ] 任务');
      await commit(instance, inserted);
      expect(instance.text).toBe(`- [ ] 任务${inserted}`);
      expect(instance.state.selection.main.head).toBe('- [ ] 任务'.length + inserted.length);
    }
  });

  it('输入法回发把光标推到闭符号之后时移回两符号之间', async () => {
    const instance = editor('- [ ] 任务');
    await commit(instance, '（）');
    // 输入法在编辑器写回文本之后会再回发一次内容相同的 textupdate，把插入点算到新文本末尾。
    instance.view.dispatch({ selection: { anchor: instance.text.length }, userEvent: 'select' });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(instance.text).toBe('- [ ] 任务（）');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务'.length + 1);
  });
});
