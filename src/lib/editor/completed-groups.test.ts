/** 文件职责：验证完成子任务整体摘要的真实预览、可达性和历史行为。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';
import { hiddenContentRanges } from './visibility';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const editors: EditorController[] = [];
function editor(text: string): EditorController {
  const instance = new EditorController(document.body, { text, mode: 'todo', onChange() {} });
  editors.push(instance); return instance;
}
function summary(instance: EditorController): HTMLButtonElement {
  return instance.view.dom.querySelector<HTMLButtonElement>('.fm-completed-summary')!;
}
afterEach(() => { editors.splice(0).forEach(instance => instance.destroy()); document.body.replaceChildren(); });

it('任务自身折叠保留同一按钮的键盘焦点，展开入口恢复完整正文', () => {
  const instance = editor('- [ ] 任务\n  正文\n  - [ ] 子任务\n');
  const trigger = instance.view.dom.querySelector<HTMLButtonElement>('.fm-fold-button')!;
  trigger.focus(); trigger.click();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  const expand = instance.view.dom.querySelector<HTMLButtonElement>('.fm-fold-summary')!;
  expect(expand.textContent).toBe('展开内容');
  expect(instance.view.dom.textContent).not.toContain('子任务');
  expand.focus(); expand.click();
  expect(document.activeElement).toBe(trigger);
  expect(instance.view.dom.textContent).toContain('子任务');
  expect(instance.view.dom.textContent).toContain('正文');
  expect(instance.undo()).toBe(false);
});

it('已完成同级子树整体隐藏为一个摘要，计数包含后代，展开不改写源文', () => {
  const text = '- [ ] 主任务\n  - [ ] 未完成\n  - [x] 已完成甲\n    甲正文\n    - [x] 孙任务\n  - [x] 已完成乙\n    乙正文\n';
  const instance = editor(text);
  expect(summary(instance)?.textContent).toBe('已完成 3 项');
  expect(instance.view.dom.textContent).not.toContain('已完成甲');
  expect(instance.view.dom.textContent).not.toContain('已完成乙');
  expect(instance.view.dom.textContent).not.toContain('孙任务');
  summary(instance).click();
  expect(summary(instance).getAttribute('aria-expanded')).toBe('true');
  expect(instance.view.dom.textContent).toContain('已完成甲');
  expect(instance.view.dom.textContent).toContain('乙正文');
  summary(instance).click();
  expect(instance.view.dom.textContent).not.toContain('乙正文');
  expect(instance.text).toBe(text);
  expect(instance.undo()).toBe(false);
});

it('新完成任务自动收起已展开组，完成与收起一起撤销，不独立归档', () => {
  const instance = editor('- [ ] 主任务\n  - [ ] 新完成\n  - [x] 旧完成\n');
  summary(instance).click();
  instance.toggleTask(instance.model.tasks[1].from);
  expect(summary(instance).textContent).toBe('已完成 2 项');
  expect(summary(instance).getAttribute('aria-expanded')).toBe('false');
  expect(instance.text).not.toContain('# 归档');
  expect(instance.view.dom.textContent).not.toContain('新完成');
  instance.undo();
  expect(summary(instance).getAttribute('aria-expanded')).toBe('true');
  expect(instance.view.dom.textContent).toContain('旧完成');
});

it('搜索定位完成子任务自动展开组，组内恢复任务后取消隐藏', () => {
  const instance = editor('- [ ] 主任务\n  - [ ] 待办\n  - [x] 完成子任务\n    正文\n');
  const child = instance.model.tasks[2];
  instance.focusAt(child.contentFrom);
  expect(summary(instance).getAttribute('aria-expanded')).toBe('true');
  expect(instance.view.dom.textContent).toContain('完成子任务');
  instance.toggleTask(child.from);
  expect(summary(instance)).toBeNull();
  expect(instance.view.dom.textContent).toContain('正文');
  expect(instance.text).not.toContain('# 归档');
});

it('整体摘要的隐藏边界保护任务源码，反复 Delete 不破坏父子结构', () => {
  const instance = editor('- [ ] 主任务\n  - [ ] 待办\n  - [x] 完成子任务\n    正文\n');
  const ranges = hiddenContentRanges(instance.state);
  expect(ranges.some(range => range.kind === 'completed-group')).toBe(true);
  instance.focusAt(instance.model.tasks[1].firstLineTo);
  const original = instance.text;
  for (let i = 0; i < 3; i++) instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
  expect(instance.text).toBe(original);
});

it('源码删除已展开父任务时，不把展开身份转移给下一任务，撤销恢复原组', () => {
  const text = '- [ ] p\n  - [x] a\n- [ ] q\n  - [x] b\n';
  const instance = editor(text);
  summary(instance).click();
  instance.setMode('source');
  const next = instance.model.tasks.find(item => instance.text.slice(item.contentFrom, item.firstLineTo) === 'q')!;
  instance.view.dispatch({ changes: { from: 0, to: next.moveFrom, insert: '' } });
  instance.setMode('todo');
  expect(summary(instance).getAttribute('aria-expanded')).toBe('false');
  expect(instance.view.dom.textContent).not.toContain('b');
  instance.undo();
  expect(instance.text).toBe(text);
  expect(summary(instance).getAttribute('aria-expanded')).toBe('true');
});
