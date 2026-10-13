/** 文件职责：验证预览控件激活后清除文本选区，同时保留控件动作和正文。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });

const text = '保留这段正文\n\n## 章节\n\n- [ ] 父任务\n  任务正文\n  - [ ] 待办子任务\n  - [x] 完成子任务\n';

it.each([
  ['折叠箭头', '.fm-fold-button', false, false],
  ['展开箭头', '.fm-fold-button', true, false],
  ['展开内容', '.fm-fold-summary', true, false],
  ['展开完成组', '.fm-completed-summary', false, false],
  ['收起完成组', '.fm-completed-summary', false, true],
  ['任务按钮', '.fm-task-checkbox', false, false],
  ['新增任务', '.fm-heading-add-button', false, false],
] as const)('%s 激活后清除不相交的文本选区', (_label, selector, folded, expanded) => {
  instance = new EditorController(document.body, { text, mode: 'todo', headingAddEnabled: true, onChange() {} });
  const parent = instance.model.tasks[0].from;
  if (folded) instance.toggleFold(parent);
  if (expanded) instance.toggleCompletedGroup(parent);
  instance.view.dispatch({ selection: { anchor: 0, head: 6 } });
  expect(instance.view.dom.querySelector('.fm-selected')).not.toBeNull();
  const button = instance.view.dom.querySelector<HTMLButtonElement>(selector)!;
  button.focus(); button.click();
  expect(instance.state.selection.main.empty).toBe(true);
  expect(instance.view.dom.querySelector('.fm-selected')).toBeNull();
  if (selector !== '.fm-heading-add-button') {
    expect(instance.state.selection.main.head).toBe(6);
    expect(instance.text).toBe(text);
    expect(instance.undo()).toBe(false);
  }
  if (selector === '.fm-task-checkbox') expect(instance.view.dom.querySelector('.fm-group-prompt')).not.toBeNull();
  if (selector === '.fm-fold-button' || selector === '.fm-fold-summary') {
    expect(instance.view.dom.querySelector('.fm-fold-button')?.getAttribute('aria-expanded')).toBe(String(folded));
    expect(document.activeElement).toBe(instance.view.dom.querySelector('.fm-fold-button'));
  }
  if (selector === '.fm-completed-summary') expect(button.getAttribute('aria-expanded')).toBe(String(!expanded));
});

it('鼠标勾选其他任务后清除文本选区，完成动作仍可撤销', () => {
  instance = new EditorController(document.body, { text: '选中的正文\n\n- [ ] 任务\n', mode: 'todo', onChange() {} });
  const original = instance.text;
  instance.view.dispatch({ selection: { anchor: 5, head: 0 } });
  const marker = instance.view.dom.querySelector<HTMLButtonElement>('.fm-task-checkbox')!;
  marker.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
  window.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
  expect(instance.state.selection.main.empty).toBe(true);
  expect(instance.view.dom.querySelector('.fm-selected')).toBeNull();
  expect(instance.text).toContain('- [x] 任务');
  expect(instance.undo()).toBe(true);
  expect(instance.text).toBe(original);
});
