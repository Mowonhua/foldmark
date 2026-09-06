/**
 * 文件职责：验证不可见正文的键盘可达性与删除保护。
 * 定义范围：真实 CodeMirror 导航、删除、显式选择、复制粘贴及源码模式行为。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorController } from './index';
import { hiddenContentRanges } from './visibility';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const instances: EditorController[] = [];
function editor(text: string): EditorController {
  const parent = document.createElement('div'); document.body.append(parent);
  const instance = new EditorController(parent, { text, mode: 'todo', onChange: () => {} });
  instances.push(instance); return instance;
}
function key(instance: EditorController, name: string): void {
  instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true }));
}
afterEach(() => { instances.splice(0).forEach(instance => instance.destroy()); document.body.replaceChildren(); });

describe('隐藏正文的导航与删除', () => {
  it('折叠后左右箭头跳过整段隐藏正文，不进入后代', () => {
    const instance = editor('- [ ] 父任务\n  长正文\n  - [ ] 子任务\n- [ ] 下一项');
    const parent = instance.model.items[0];
    instance.focusAt(parent.firstLineTo); instance.toggleFold(parent.from);
    key(instance, 'ArrowRight'); expect(instance.state.selection.main.head).toBe(parent.to);
    key(instance, 'ArrowLeft'); expect(instance.state.selection.main.head).toBe(parent.firstLineTo);
    expect(instance.undo()).toBe(false);
  });

  it('可见项首行 Backspace 不删除前面的归档正文', () => {
    const source = '- [ ] 前一项\n- [x] 已归档\n  不能丢失的正文\n- [ ] 后一项';
    const instance = editor(source); const after = instance.model.tasks[2];
    instance.focusAt(after.from); key(instance, 'Backspace');
    expect(instance.text).toBe(source);
    expect(instance.state.selection.main.head).toBe(instance.model.tasks[0].firstLineTo);
    expect(instance.undo()).toBe(false);
  });

  it('可见行尾 Delete 不合并并破坏后面的隐藏任务边界', () => {
    const source = '- [ ] 前一项\n- [x] 已归档\n  不能丢失的正文\n- [ ] 后一项';
    const instance = editor(source);
    instance.focusAt(instance.model.tasks[0].firstLineTo); key(instance, 'Delete');
    expect(instance.text).toBe(source);
    expect(instance.state.selection.main.head).toBe(instance.model.tasks[2].from);
  });

  it('折叠范围末端的 Backspace 只回到首行，不删除整个折叠段', () => {
    const source = '- [ ] 父任务\n  保留折叠正文\n- [ ] 后一项';
    const instance = editor(source); const parent = instance.model.tasks[0];
    instance.toggleFold(parent.from);
    instance.view.dispatch({ selection: { anchor: parent.to } });
    key(instance, 'Backspace');
    expect(instance.text).toBe(source); expect(instance.state.selection.main.head).toBe(parent.firstLineTo);
  });

  it('主动跨任务选区仍能复制、删除、粘贴和撤销全部原文', () => {
    const source = '- [ ] 前一项\n- [x] 隐藏任务\n  原正文\n- [ ] 后一项';
    const instance = editor(source);
    const from = instance.model.tasks[0].contentFrom;
    const to = instance.model.tasks[2].contentFrom;
    instance.view.focus(); instance.view.dispatch({ selection: { anchor: from, head: to } });
    const copied: Record<string, string> = {};
    const copy = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', { value: { clearData() {}, setData: (format: string, value: string) => { copied[format] = value; } } });
    instance.view.contentDOM.dispatchEvent(copy);
    expect(copied['text/plain']).toBe(source.slice(from,to));
    key(instance, 'Backspace'); expect(instance.text).toBe(source.slice(0,from)+source.slice(to));
    expect(instance.undo()).toBe(true); expect(instance.text).toBe(source);
    instance.view.dispatch({ selection: { anchor: from, head: to } });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: (format: string) => format === 'text/plain' ? '替换内容' : '', types: ['text/plain'], files: [] } });
    instance.view.contentDOM.dispatchEvent(paste);
    expect(instance.text).toBe(source.slice(0,from)+'替换内容'+source.slice(to));
    expect(instance.undo()).toBe(true); expect(instance.text).toBe(source);
  });

  it('源码模式对已完成任务保留普通单字符删除', () => {
    const source = '- [x] 已完成任务\n  正文';
    const instance = editor(source); instance.setMode('source');
    const position = source.indexOf('完成') + 1;
    instance.focusAt(position); key(instance, 'Backspace');
    expect(instance.text).toBe(source.slice(0,position-1)+source.slice(position));
  });

  it('源码切回待办后将不可见光标收拢到可见边界，不改原文历史', () => {
    const source = '- [ ] 前一项\n- [x] 已完成任务\n  隐藏正文\n- [ ] 后一项';
    const instance = editor(source); instance.setMode('source'); instance.focusAt(source.indexOf('隐藏正文')+2);
    instance.setMode('todo');
    const hidden = hiddenContentRanges(instance.state);
    expect(hidden.every(range=>instance.state.selection.main.head <= range.from || instance.state.selection.main.head >= range.to)).toBe(true);
    expect(instance.text).toBe(source); expect(instance.undo()).toBe(false);
  });
});

describe('折叠条目与下一行的分隔', () => {
  it('下一项行首 Backspace 不能把可见任务并入折叠正文', () => {
    const source = '- [ ] 父任务\n  折叠正文\n- [ ] 后一项';
    const instance = editor(source); const parent = instance.model.tasks[0];
    instance.toggleFold(parent.from); instance.focusAt(instance.model.tasks[1].from);
    key(instance,'Backspace');
    expect(instance.text).toBe(source);
    expect(instance.state.selection.main.head).toBe(parent.firstLineTo);
  });
});
