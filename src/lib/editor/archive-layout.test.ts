/** 文件职责：验证归档移动与真实编辑器历史、光标和折叠的协作。 */
import { afterEach, expect, it, vi } from 'vitest';
import { EditorController } from './index';
import { archiveSections, getHiddenRanges, searchTasks } from '../markdown';
import { foldsField } from './state';
const instances: EditorController[] = [];
function editor(text: string) {
  const instance = new EditorController(document.body, { text, mode: 'todo', onChange() {} });
  instances.push(instance); return instance;
}
afterEach(() => { instances.splice(0).forEach(instance => instance.destroy()); document.body.replaceChildren(); });
it('带根缩进的完成任务归档后保留展开状态，光标正确跟随未移动正文', () => {
  const instance = editor('  - [ ] root\n    body\n  - [ ] open\n');
  instance.focusAt(instance.text.indexOf('open'));
  instance.toggleTask(instance.model.tasks[0].from);
  const root = instance.model.tasks.find(item => instance.text.slice(item.contentFrom, item.firstLineTo) === 'root')!;
  expect(instance.state.field(foldsField).has(root.from)).toBe(false);
  expect(instance.text.slice(instance.state.selection.main.head, instance.state.selection.main.head + 4)).toBe('open');
});
it('完成实际移动完整正文，单次撤销恢复原布局，重做重新归档', () => {
  const source = '# 今天\n\n- [ ] 甲\n  正文\n- [ ] 乙\n';
  const instance = editor(source);
  instance.toggleTask(instance.model.tasks[0].from);
  expect(instance.text).toMatch(/- \[ \] 乙[\s\S]*# 归档\n\n- \[x\] 甲\n  正文/);
  expect(instance.text.slice(archiveSections(instance.model)[0].headingTo)).not.toContain('# 今天');
  instance.undo(); expect(instance.text).toBe(source);
  instance.redo(); expect(instance.text).toContain('# 归档');
});
it('真实编辑器归档省略一级标题，预览、分区源码、搜索和恢复保留子标题路径', () => {
  const source = '# 工作\n\n## 开发\n\n- [ ] 甲\n  正文\n\n# 其他\n\n- [ ] 乙\n';
  const instance = editor(source);
  instance.toggleTask(instance.model.tasks[0].from);
  const section = archiveSections(instance.model)[0];
  expect(instance.text.slice(section.headingTo)).toContain('## 开发\n\n- [x] 甲');
  expect(instance.text.slice(section.headingTo)).not.toContain('# 工作');
  expect(instance.view.contentDOM.textContent).not.toContain('甲');
  instance.setMode('archive');
  expect(instance.view.contentDOM.textContent).not.toContain('工作');
  expect(instance.view.contentDOM.textContent).toContain('开发');
  expect(instance.view.contentDOM.textContent).toContain('甲');
  expect(instance.view.contentDOM.textContent).not.toContain('其他');
  expect(instance.view.contentDOM.textContent).not.toContain('foldmark:archive');
  expect(searchTasks(instance.model, '甲', true)[0].heading).toBe('开发');
  instance.toggleSource();
  expect(instance.view.contentDOM.textContent).toContain('<!-- foldmark:archive -->');
  expect(instance.view.contentDOM.textContent).toContain('## 开发');
  expect(instance.view.contentDOM.textContent).not.toContain('# 工作');
  expect(instance.view.contentDOM.textContent).not.toContain('乙');
  instance.toggleSource();
  const archived = instance.text;
  instance.toggleTask(instance.model.tasks.find(task => instance.text.slice(task.contentFrom, task.firstLineTo) === '甲')!.from);
  expect(instance.text.indexOf('甲')).toBeLessThan(instance.text.indexOf('# 其他'));
  instance.undo(); expect(instance.text).toBe(archived);
  instance.redo();
  instance.setMode('todo');
  expect(instance.view.contentDOM.textContent).toContain('甲');
  expect(instance.text).toContain('## 开发\n\n- [ ] 甲\n  正文');
});
it('重新载入无一级标题的归档后，恢复到待办一级标题下唯一匹配的子章节', () => {
  const initial = editor('# 工作\n\n## 开发\n\n- [ ] 甲\n\n# 笔记\n\n- [ ] 乙\n');
  initial.toggleTask(initial.model.tasks[0].from);
  const reopened = editor(initial.text);
  reopened.setMode('archive');
  expect(reopened.view.contentDOM.textContent).not.toContain('工作');
  expect(reopened.view.contentDOM.textContent).toContain('开发');
  reopened.toggleTask(reopened.model.tasks.find(item => reopened.text.slice(item.contentFrom, item.firstLineTo) === '甲')!.from);
  const active = reopened.text.slice(0, archiveSections(reopened.model)[0].from);
  expect(active).toContain('# 工作\n\n## 开发\n\n- [ ] 甲');
  expect(active.match(/^## 开发$/gm)).toHaveLength(1);
  expect(active.indexOf('甲')).toBeLessThan(active.indexOf('# 笔记'));
});
it('新增待办插到归档前，正文编辑位置和折叠不被其他任务归档抢走', () => {
  const instance = editor('- [ ] 甲\n- [ ] 乙\n  正文\n');
  instance.focusAt(instance.text.indexOf('乙'));
  instance.toggleFold(instance.model.tasks[1].from);
  instance.toggleTask(0);
  expect(instance.text[instance.state.selection.main.head]).toBe('乙');
  expect(instance.state.field(foldsField).has(instance.model.tasks.find(item => instance.text.slice(item.contentFrom, item.firstLineTo) === '乙')!.from)).toBe(true);
  instance.insertTask();
  expect(instance.state.selection.main.head).toBeLessThan(instance.text.indexOf('# 归档'));
});
it('源码编辑时不搬动正在输入的文本，返回待办后整理且可撤销', () => {
  const instance = editor('- [ ] 甲\n');
  instance.setMode('source');
  instance.view.dispatch({ changes: { from: 3, to: 4, insert: 'x' } });
  expect(instance.text).toBe('- [x] 甲\n');
  instance.setMode('todo');
  expect(instance.text).toContain('# 归档');
  instance.undo(); expect(instance.text).toBe('- [x] 甲\n');
});
it('归档备注和系统标题整体退出待办视图，恢复任务仍移回标题之前', () => {
  const instance = editor('- [ ] 工作\n\n# 归档\n\n归档备注\n\n- [x] 旧任务\n');
  const sections = getHiddenRanges(instance.model, 'todo');
  expect(sections.some(range => range.from <= instance.text.indexOf('# 归档') && range.to === instance.text.length)).toBe(true);
  instance.setMode('archive');
  instance.toggleTask(instance.model.tasks[1].from);
  expect(instance.text.indexOf('- [ ] 旧任务')).toBeLessThan(instance.text.indexOf('# 归档'));
  expect(instance.text).toContain('归档备注');
});
it('末尾未闭合围栏时保留原文并提示暂缓，补全后再次整理', () => {
  const onStatus = vi.fn();
  const instance = new EditorController(document.body, { text: '- [ ] 甲\n\n```\ncode', mode: 'todo', onChange() {}, onStatus });
  instances.push(instance);
  instance.toggleTask(0);
  expect(instance.text).toBe('- [x] 甲\n\n```\ncode');
  expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('暂缓整理归档'));
  instance.setMode('source');
  instance.view.dispatch({ changes: { from: instance.text.length, insert: '\n```\n' } });
  instance.setMode('todo');
  expect(instance.text).toMatch(/```\ncode\n```[\s\S]*# 归档\n\n- \[x\] 甲/);
});
