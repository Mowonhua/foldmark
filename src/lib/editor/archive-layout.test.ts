/** 文件职责：验证归档移动与真实编辑器历史、光标和折叠的协作。 */
import { afterEach, expect, it, vi } from 'vitest';
import { EditorController } from './index';
import { getHiddenRanges } from '../markdown';
const instances: EditorController[] = [];
function editor(text: string) {
  const instance = new EditorController(document.body, { text, mode: 'todo', onChange() {} });
  instances.push(instance); return instance;
}
afterEach(() => { instances.splice(0).forEach(instance => instance.destroy()); document.body.replaceChildren(); });
it('完成实际移动完整正文，单次撤销恢复原布局，重做重新归档', () => {
  const source = '# 今天\n\n- [ ] 甲\n  正文\n- [ ] 乙\n';
  const instance = editor(source);
  instance.toggleTask(instance.model.tasks[0].from);
  expect(instance.text).toMatch(/- \[ \] 乙[\s\S]*# 归档\n\n- \[x\] 甲\n  正文/);
  instance.undo(); expect(instance.text).toBe(source);
  instance.redo(); expect(instance.text).toContain('# 归档');
});
it('新增待办插到归档前，正文编辑位置和折叠不被其他任务归档抢走', () => {
  const instance = editor('- [ ] 甲\n- [ ] 乙\n  正文\n');
  instance.focusAt(instance.text.indexOf('乙'));
  instance.toggleFold(instance.model.tasks[1].from);
  instance.toggleTask(0);
  expect(instance.text[instance.state.selection.main.head]).toBe('乙');
  expect(instance.getUIState().folded).toHaveLength(1);
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
