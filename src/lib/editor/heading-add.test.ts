/** 文件职责：验证待办视图标题下新增入口的渲染条件、悬停联动与插入落点。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const editors: EditorController[] = [];
function editor(text: string, mode: 'todo' | 'source' | 'archive' = 'todo'): EditorController {
  const instance = new EditorController(document.body, { text, mode, onChange() {}, headingAddEnabled: true });
  editors.push(instance); return instance;
}
afterEach(() => { editors.splice(0).forEach(instance => instance.destroy()); document.body.replaceChildren(); });

function entry(instance: EditorController, headingFrom: number): HTMLElement {
  return instance.view.dom.querySelector<HTMLElement>(`.fm-heading-add[data-heading-add="${headingFrom}"]`)!;
}

it('待办视图为各级章节标题渲染配对的新增入口', () => {
  const text = '# 总\n\n## 甲\n\n### 乙';
  const view = editor(text);
  const heads = ['# 总', '## 甲', '### 乙'].map(marker => text.indexOf(marker));
  expect(view.view.dom.querySelectorAll('.fm-heading-add')).toHaveLength(3);
  expect([...view.view.dom.querySelectorAll('[data-heading-line]')].map(line => line.getAttribute('data-heading-line')))
    .toEqual(heads.map(String));
});

it('控件内联在标题行末尾，空行照常折叠', () => {
  const text = '## 甲\n\n- [ ] 乙';
  const view = editor(text);
  const headLine = view.view.dom.querySelector('.cm-line[data-heading-line]')!;
  // 控件内联在标题行内；紧随标题的空行由段落分隔折叠，标题行的下一个可见块就是任务行。
  expect(headLine.querySelector('.fm-heading-add')).toBeTruthy();
  expect(headLine.nextElementSibling?.classList.contains('cm-line')).toBe(true);
  expect(headLine.nextElementSibling?.textContent).toContain('乙');
});

it.each(['source', 'archive'] as const)('%s 视图不渲染标题新增入口', mode => {
  const view = editor('## 甲\n\n- [ ] 乙', mode);
  expect(view.view.dom.querySelectorAll('.fm-heading-add')).toHaveLength(0);
});

it('入口默认关闭，可经控制器开关实时启用与停用', () => {
  const text = '## 甲\n\n- [ ] 乙';
  const off = new EditorController(document.body, { text, mode: 'todo', onChange() {} });
  editors.push(off);
  expect(off.view.dom.querySelectorAll('.fm-heading-add')).toHaveLength(0);
  off.setHeadingAddEnabled(true);
  expect(off.view.dom.querySelectorAll('.fm-heading-add')).toHaveLength(1);
  off.setHeadingAddEnabled(false);
  expect(off.view.dom.querySelectorAll('.fm-heading-add')).toHaveLength(0);
  expect(off.text).toBe(text);
  // 停用状态创建的后台项目在恢复时对齐当前开关。
  off.setHeadingAddEnabled(true);
  const stale = off.createState(text, 'todo');
  off.setHeadingAddEnabled(false);
  off.restoreState(stale);
  expect(off.view.dom.querySelectorAll('.fm-heading-add')).toHaveLength(0);
});

it('列表项内的标题不属于章节，不渲染新增入口', () => {
  const view = editor('- [ ] 甲\n  ## 内');
  expect(view.view.dom.querySelectorAll('.fm-heading-add')).toHaveLength(0);
});

it('悬停标题显示对应按钮，移到正文或离开编辑器后收起', () => {
  const text = '## 甲\n\n- [ ] 乙';
  const view = editor(text);
  const headLine = view.view.dom.querySelector<HTMLElement>('[data-heading-line]')!;
  const wrap = entry(view, 0);
  headLine.dispatchEvent(new Event('pointerover', { bubbles: true }));
  expect(wrap.classList.contains('is-open')).toBe(true);
  const taskLine = [...view.view.dom.querySelectorAll<HTMLElement>('.cm-line')].find(line => !line.hasAttribute('data-heading-line'))!;
  taskLine.dispatchEvent(new Event('pointerover', { bubbles: true }));
  expect(wrap.classList.contains('is-open')).toBe(false);
  headLine.dispatchEvent(new Event('pointerover', { bubbles: true }));
  headLine.dispatchEvent(new Event('pointerout', { bubbles: true }));
  expect(wrap.classList.contains('is-open')).toBe(false);
});

it('悬停在按钮自身或另一标题上时保持或转移显示', () => {
  const text = '## 甲\n\n## 乙';
  const view = editor(text);
  const [first, second] = [...view.view.dom.querySelectorAll<HTMLElement>('[data-heading-line]')];
  first.dispatchEvent(new Event('pointerover', { bubbles: true }));
  const firstWrap = entry(view, 0);
  firstWrap.querySelector('button')!.dispatchEvent(new Event('pointerover', { bubbles: true }));
  expect(firstWrap.classList.contains('is-open')).toBe(true);
  second.dispatchEvent(new Event('pointerover', { bubbles: true }));
  expect(firstWrap.classList.contains('is-open')).toBe(false);
  expect(entry(view, text.indexOf('## 乙')).classList.contains('is-open')).toBe(true);
});

it('点击按钮在标题之后插入任务，光标进入新任务且可撤销', () => {
  const view = editor('## 甲\n\n- [ ] 旧');
  const button = entry(view, 0).querySelector('button')!;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(view.text).toBe('## 甲\n- [ ] \n\n- [ ] 旧');
  expect(view.state.selection.main.head).toBe('## 甲\n- [ ] '.length);
  view.undo();
  expect(view.text).toBe('## 甲\n\n- [ ] 旧');
});

it('标题直接跟随任务或位于文档末行时插入位置仍正确', () => {
  const compact = editor('## 甲\n- [ ] 旧');
  const button = compact.view.dom.querySelector<HTMLButtonElement>('.fm-heading-add-button')!;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(compact.text).toBe('## 甲\n- [ ] \n\n- [ ] 旧');
  compact.destroy();
  document.body.replaceChildren();
  const trailing = editor('## 甲');
  const endButton = trailing.view.dom.querySelector<HTMLButtonElement>('.fm-heading-add-button')!;
  endButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(trailing.text).toBe('## 甲\n- [ ] ');
  expect(trailing.state.selection.main.head).toBe(trailing.text.length);
});
