/** 文件职责：验证语言切换只更新编辑器界面，并保留正文、选区与撤销历史。 */
import { afterEach, expect, it, vi } from 'vitest';
import { EditorController } from './index';
import { setLocalePreference } from '../i18n';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let editor: EditorController | undefined;
afterEach(() => { editor?.destroy(); editor = undefined; setLocalePreference('zh-CN'); document.body.replaceChildren(); });

it('切换语言刷新挂载控件并保留正文、选区和历史，恢复后台状态也使用当前语言', () => {
  setLocalePreference('zh-CN');
  const parent = document.createElement('div'); document.body.append(parent);
  const onChange = vi.fn();
  editor = new EditorController(parent, { text: '- [ ] 中文正文', mode: 'todo', onChange });
  editor.view.dispatch({ changes: { from: editor.text.length, insert: '!' }, selection: { anchor: 8 } });
  const snapshot = editor.state;
  const text = editor.text;
  onChange.mockClear();
  setLocalePreference('en');
  expect(editor.view.contentDOM.getAttribute('aria-label')).toBe('Markdown task document');
  expect(parent.querySelector('.fm-task-checkbox')?.getAttribute('aria-label')).toBe('Complete task');
  expect(editor.text).toBe(text);
  expect(editor.state.selection.eq(snapshot.selection)).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
  editor.restoreState(snapshot);
  expect(parent.querySelector('.fm-task-checkbox')?.getAttribute('aria-label')).toBe('Complete task');
  expect(editor.undo()).toBe(true);
  expect(editor.text).toBe('- [ ] 中文正文');
  setLocalePreference('zh-CN');
  expect(parent.querySelector('.fm-task-checkbox')?.getAttribute('aria-label')).toBe('完成任务');
});

it('空文档提示和已打开的条目菜单随语言更新', () => {
  setLocalePreference('zh-CN');
  const parent = document.createElement('div'); document.body.append(parent);
  editor = new EditorController(parent, { text: '', mode: 'todo', onChange: () => {} });
  setLocalePreference('en');
  expect(parent.querySelector('.cm-placeholder')?.textContent).toContain('Write your first item');
  editor.setText('- [ ] 内容');
  const marker = parent.querySelector('.fm-task-checkbox')!;
  marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(document.querySelector('.fm-item-menu')?.textContent).toContain('Move up');
  setLocalePreference('zh-CN');
  expect(document.querySelector('.fm-item-menu')?.textContent).toContain('上移');
  expect(editor.text).toBe('- [ ] 内容');
});
