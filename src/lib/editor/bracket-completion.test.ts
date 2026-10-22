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

/** 模拟输入法在组合会话中写入文本但不结束组合：正文此时应当只有输入法写入的原样内容。 */
async function writeComposing(instance: EditorController, inserted: string): Promise<void> {
  const at = instance.state.selection.main.head;
  const dom = instance.view.domAtPos(at);
  const node = dom.node as Text;
  instance.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  node.insertData(dom.offset, inserted);
  document.getSelection()!.collapse(node, dom.offset + inserted.length);
  instance.view.contentDOM.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: inserted, bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
}

/** 结束组合会话，模拟输入法提交；补齐等组合结束之后才做的动作在这一步完成。 */
function endComposing(instance: EditorController, inserted: string): void {
  instance.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: inserted }));
}

/** 模拟输入法组合会话中提交文本：input 事件先于 compositionend 到达，与中文输入法提交全角符号一致。 */
async function typeComposing(instance: EditorController, inserted: string): Promise<void> {
  await writeComposing(instance, inserted);
  endComposing(instance, inserted);
}

/**
 * 等过 CodeMirror 的组合结束按键窗口。
 * 说明：CodeMirror 为 Safari 保留了「组合结束后 100ms 内忽略按键」的保护（输入法用回车确认候选字），
 *   测试环境同样被识别成 Safari，所以组合提交后立即按键等于输入法的确认键，不等待就测不到用户的下一次按键。
 */
function afterComposition(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 120));
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

  it.each([['（', '（）'], ['［', '［］'], ['【', '【】'], ['「', '「」'], ['“', '“”'], ['(', '()']])('桌面输入法组合中提交 %s 同样补齐为 %s 并把光标放到中间', async (inserted, pair) => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await typeComposing(instance, inserted);
    expectCentered(instance, pair);
    expect(instance.state.selection.main.head).toBe('- [ ] 任务'.length + 1);
  });

  it('桌面输入法组合中提交闭符号时跳过已补齐的闭符号', async () => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await typeComposing(instance, '（');
    await typeComposing(instance, '）');
    expect(instance.text).toBe('- [ ] 任务（）');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务（）'.length);
  });

  it('桌面输入法组合期间不补齐，组合结束后才补出整对', async () => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await writeComposing(instance, '（');
    expect(instance.text).toBe('- [ ] 任务（');
    endComposing(instance, '（');
    expectCentered(instance, '（）');
  });

  it('输入法补出的整对与键盘补齐一样按 Backspace 一次删除', async () => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await typeComposing(instance, '（');
    await afterComposition();
    instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true, cancelable: true }));
    expect(instance.text).toBe('- [ ] 任务');
  });

  it('输入法提交全角括号后回车照常新建任务', async () => {
    const instance = editor('- [ ] 任务');
    instance.focusAt(instance.text.length);
    await typeComposing(instance, '（');
    instance.focusAt(instance.text.length);
    await afterComposition();
    instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(instance.text).toBe('- [ ] 任务（）\n\n- [ ] ');
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

  it('手机在汉字之后输入引号同样补齐为整对', async () => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, '"');
    expectCentered(instance, '""');
  });

  it('手机在英文单词内部输入引号不补齐', async () => {
    const instance = editor('- [ ] don', true);
    instance.focusAt(instance.text.length);
    await type(instance, '"');
    expect(instance.text).toBe('- [ ] don"');
  });

  it('手机在补齐的闭符号前再输入闭符号时移过去，而不是重复插入', async () => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, '（');
    // 回发窗口内、同一位置的闭符号按输入法回发处理，这里等窗口过去再按键，代表用户自己按闭符号。
    await new Promise(resolve => setTimeout(resolve, 60));
    await type(instance, '）');
    expect(instance.text).toBe('- [ ] 任务（）');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务（）'.length);
  });

  it('手机补齐后输入法把闭符号回发回来时保持居中，不重复插入', async () => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, '（');
    await type(instance, '）');
    expect(instance.text).toBe('- [ ] 任务（）');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务（'.length);
  });

  it('手机在没有配对开符号的位置输入闭符号时照常插入', async () => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, '）');
    expect(instance.text).toBe('- [ ] 任务）');
  });

  it('手机在一对全角符号内部再输入同一个开符号时补齐内层闭符号', async () => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, '（');
    await type(instance, '（');
    expect(instance.text).toBe('- [ ] 任务（（））');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务（（'.length);
  });

  it('手机在一对半角符号内部再输入同一个开符号时补齐内层闭符号', async () => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, '(');
    await type(instance, '(');
    expect(instance.text).toBe('- [ ] 任务(())');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务(('.length);
  });

  it('手机补齐后输入法把光标推到闭符号之后时移回两符号之间', async () => {
    const instance = editor('- [ ] 任务', true);
    instance.focusAt(instance.text.length);
    await type(instance, '（');
    // 输入法在编辑器写回文本之后会再回发一次内容相同的 textupdate，把插入点算到新文本末尾。
    instance.view.dispatch({ selection: { anchor: instance.text.length }, userEvent: 'select' });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(instance.text).toBe('- [ ] 任务（）');
    expect(instance.state.selection.main.head).toBe('- [ ] 任务（'.length);
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

