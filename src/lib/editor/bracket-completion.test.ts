/** 文件职责：验证桌面键盘自动补齐成对符号并把光标放到中间，手机交给输入法配对。 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorController } from './index';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const editors: EditorController[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren(); });

function editor(text: string, nativeSelection = false): EditorController {
  const instance = new EditorController(document.body.appendChild(document.createElement('div')), { text, mode: 'todo', nativeSelection, onChange: () => {} });
  editors.push(instance);
  return instance;
}

/** 模拟键盘或输入法一次插入：在当前选区位置写入 DOM 后派发 input 事件，由编辑器读取这次 DOM 变更。 */
async function type(instance: EditorController, inserted: string): Promise<void> {
  const at = instance.state.selection.main.head;
  const dom = instance.view.domAtPos(at);
  const node = dom.node as Text;
  node.insertData(dom.offset, inserted);
  document.getSelection()!.collapse(node, dom.offset + inserted.length);
  instance.view.contentDOM.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: inserted, bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
}

describe('桌面键盘成对符号补全', () => {
  it.each([['(', '()'], ['[', '[]'], ['{', '{}']])('输入 %s 补齐为 %s 并把光标放到中间', async (inserted, pair) => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await type(instance, inserted);
    expect(instance.text).toBe(`- [ ] 任务${pair}`);
    expect(instance.state.selection.main.head).toBe('- [ ] 任务'.length + 1);
  });

  it('引号在词边界补齐，在单词内部不补齐以避免影响撇号', async () => {
    const boundary = editor('- [ ] a ');
    boundary.focusAt(boundary.text.length);
    await type(boundary, '"');
    expect(boundary.text).toBe('- [ ] a ""');
    expect(boundary.state.selection.main.head).toBe('- [ ] a "'.length);
    const insideWord = editor('- [ ] don');
    insideWord.focusAt(insideWord.text.length);
    await type(insideWord, "'");
    expect(insideWord.text).toBe("- [ ] don'");
  });

  it('手机保留输入法配对，不额外补齐', async () => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, '(');
    expect(instance.text).toBe('- [ ] 任务(');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务('.length);
  });

  it('在补齐的闭符号前再输入闭符号时跳过，而不是重复插入', async () => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await type(instance, '(');
    await type(instance, ')');
    expect(instance.text).toBe('- [ ] 任务()');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务()'.length);
  });

  it('成对符号之间按 Backspace 一次删除整对', async () => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await type(instance, '(');
    instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true, cancelable: true }));
    expect(instance.text).toBe('- [ ] 任务');
  });
});
