/** 文件职责：核验松散任务列表末项完成后的祖先、选区和后台语法模型。 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EditorController } from './index';
import { parseDocument, taskIsArchived } from '../markdown';

const instances: EditorController[] = [];
beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { instances.splice(0).forEach(instance => instance.destroy()); document.body.replaceChildren(); });

it.each(['', '\n', '\n\n', '\n\n\n', '\n  正文\n\n'])('松散列表末项完成后后台解析与反复整理不独立归档，尾部 %j', async suffix => {
  const source = '- [ ] task main\n\n  - [ ] sub1\n\n  - [ ] sub2\n\n  - [ ] sub3' + suffix;
  const instance = new EditorController(document.body, { text: source, mode: 'todo', onChange() {} });
  instances.push(instance);
  const sub3 = instance.model.tasks[3];
  expect(sub3.parentFrom).toBe(0);
  instance.focusAt(sub3.contentFrom);
  instance.toggleTask(sub3.from);
  await new Promise(resolve => setTimeout(resolve, 750));
  for (let pass = 0; pass < 2; pass++) {
    instance.normalizeArchive();
    const child = instance.model.tasks.find(item => instance.text.slice(item.contentFrom, item.firstLineTo) === 'sub3')!;
    expect(child.task?.checked).toBe(true);
    expect(child.parentFrom).toBe(0);
    expect(taskIsArchived(instance.model, child)).toBe(false);
    expect(instance.text).not.toContain('# 归档');
    expect(instance.model.items).toEqual(parseDocument(instance.text).items);
    instance.setText(instance.text, true);
  }
});
