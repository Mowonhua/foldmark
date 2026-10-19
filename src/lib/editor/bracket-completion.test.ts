/** 文件职责：验证成对符号补齐的两条路径——桌面键盘补齐半角与全角符号，手机输入单个符号同样补齐并把光标放到中间。 */
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

/** 断言文档末尾补出整对符号，且光标停在开符号之后。 */
function expectCentered(instance: EditorController, pair: string): void {
  expect(instance.text).toBe(`- [ ] 任务${pair}`);
  expect(instance.state.selection.main.head).toBe('- [ ] 任务'.length + 1);
}

const KEYBOARD_PAIRS = [['(', '()'], ['[', '[]'], ['{', '{}'], ['（', '（）'], ['［', '［］'], ['｛', '｛｝'], ['【', '【】'], ['《', '《》'], ['〈', '〈〉'], ['「', '「」'], ['『', '『』'], ['“', '“”'], ['‘', '‘’']];

describe('成对符号补全', () => {
  it.each(KEYBOARD_PAIRS)('桌面键盘输入 %s 补齐为 %s 并把光标放到中间', async (inserted, pair) => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await type(instance, inserted);
    expectCentered(instance, pair);
  });

  it('桌面键盘不补齐尖括号，保留 Markdown 的 HTML 与自动链接写法', async () => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await type(instance, '<');
    expect(instance.text).toBe('- [ ] 任务<');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务<'.length);
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

  it.each([['(', '()'], ['（', '（）'], ['“', '“”']])('手机输入单个 %s 同样补齐为 %s 并把光标放到中间', async (inserted, pair) => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, inserted);
    expectCentered(instance, pair);
  });

  it('手机英文撇号在单词内部不补齐', async () => {
    const instance = editor('- [ ] don', true);
    instance.focusAt(instance.text.length);
    await type(instance, "'");
    expect(instance.text).toBe("- [ ] don'");
  });

  it('手机在补齐的闭符号前再输入闭符号时移过去，而不是重复插入', async () => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, '（');
    await type(instance, '）');
    expect(instance.text).toBe('- [ ] 任务（）');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务（）'.length);
  });

  it('成对符号之间按 Backspace 一次删除整对', async () => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await type(instance, '(');
    instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true, cancelable: true }));
    expect(instance.text).toBe('- [ ] 任务');
  });

  it('手机按 Backspace 同样一次删除整对全角符号', async () => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, '【');
    instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true, cancelable: true }));
    expect(instance.text).toBe('- [ ] 任务');
  });
});
