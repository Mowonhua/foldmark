import { describe, expect, it } from 'vitest';
import { parseDocument } from './parse';
import { archiveSections, normalizeArchiveChanges } from './archive';
import { taskToggleChanges } from './transactions';
import type { TextChange } from './types';

const apply = (text: string, changes: TextChange[]): string => [...changes].sort((left, right) => right.from - left.from).reduce((result, change) => result.slice(0, change.from) + change.insert + result.slice(change.to), text);
const normalize = (text: string, completedFrom: readonly number[] = []): string => apply(text, normalizeArchiveChanges(parseDocument(text), completedFrom));

describe('managed archive layout', () => {
  it('前插归档时已有普通列表容器不成为新任务的后代，恢复项也不重复', () => {
    const result = normalize('- [x] newest\n\n# 归档\n\n  - bucket\n    - [x] previous\n    - [ ] restored\n');
    const model = parseDocument(result);
    expect(model.tasks).toHaveLength(3);
    const previous = model.tasks.find(item => model.text.slice(item.contentFrom, item.firstLineTo) === 'previous')!;
    const parent = model.items.find(item => item.from === previous.parentFrom)!;
    expect(parent.task).toBeNull();
    expect(parent.parentFrom).toBeNull();
    expect(result.indexOf('restored')).toBeLessThan(result.indexOf('# 归档'));
    expect(normalize(result)).toBe(result);
  });
  it('前插归档时仍保留已有带根缩进任务的独立拓扑', () => {
    const result = normalize('- [x] newest\n\n# 归档\n\n  - [x] previous\n');
    expect(parseDocument(result).tasks.every(item => item.parentFrom === null)).toBe(true);
    expect(result.indexOf('newest')).toBeLessThan(result.indexOf('previous'));
    expect(normalize(result)).toBe(result);
  });
  it('归档不同根缩进的任务不会把后一个根附着为前一个的子任务', () => {
    const source = '  - ordinary\n    - [x] a\n\n  - [x] b\n  - [ ] open\n';
    const result = normalize(source);
    const archived = parseDocument(result).tasks.filter(item => item.task?.checked);
    expect(archived).toHaveLength(2);
    expect(archived.every(item => item.parentFrom === null)).toBe(true);
    expect(normalize(result)).toBe(result);
  });
  it('moves completed subtrees to the final archive and preserves unrelated prose', () => {
    const source = '# 工作\n\n- [ ] open\n- [x] done\n  body\n  - [x] child\n\n# 笔记\n\nkeep exactly\n';
    const result = normalize(source);
    expect(result).toContain('# 工作\n\n- [ ] open\n\n# 笔记\n\nkeep exactly\n');
    expect(result).toMatch(/# 归档\n\n- \[x\] done\n  body\n  - \[x\] child\n$/);
    expect(normalize(result)).toBe(result);
  });
  it('retains a completed nested subtree under its unfinished task ancestor', () => {
    const source = '- [ ] parent\n  - [ ] sibling\n  - [x] child\n\n    paragraph\n\n    ```ts\n    code\n    ```\n';
    const result = normalize(source);
    expect(result).toBe(source);
    expect(parseDocument(result).tasks[2].parentFrom).toBe(0);
    expect(normalize(result)).toBe(result);
  });
  it('restores an incomplete archive group with all completed children still attached', () => {
    const result = normalize('- [ ] work\n\n# 归档\n\n- [x] parent\n  - [ ] restored\n  - [x] finished\n');
    expect(result.indexOf('- [x] parent')).toBeLessThan(result.indexOf('# 归档'));
    expect(result.indexOf('  - [ ] restored')).toBeLessThan(result.indexOf('# 归档'));
    expect(result).toContain('- [x] parent\n  - [ ] restored\n  - [x] finished\n\n# 归档');
    expect(result).not.toContain('# 归档\n\n- [x] finished');
    expect(normalize(result)).toBe(result);
  });
  it('waits for the outer task even when its checked descendants are fully complete', () => {
    const source = '- [ ] root\n  - [x] parent\n    - [x] child\n';
    expect(normalize(source)).toBe(source);
    const completed = normalize(source.replace('- [ ] root', '- [x] root'));
    expect(completed).toBe('# 归档\n\n- [x] root\n  - [x] parent\n    - [x] child\n');
    expect(normalize(completed)).toBe(completed);
  });
  it('keeps completed tasks attached through ordinary list ancestors', () => {
    const source = '- [ ] root\n  - ordinary\n    - [x] child\n      body\n';
    expect(normalize(source)).toBe(source);
    const completed = normalize(source.replace('- [ ] root', '- [x] root'));
    expect(completed).toContain('# 归档\n\n- [x] root\n  - ordinary\n    - [x] child\n      body\n');
    expect(parseDocument(completed).tasks).toHaveLength(2);
  });
  it('prepends newly archived groups while preserving the existing archive order and notes', () => {
    const source = '- [ ] work\n- [x] newest\n  - [x] newest child\n\n# 归档\n\n- [x] previous\n  body\n- [x] oldest\n\narchive note\n';
    const result = normalize(source);
    expect(result).toContain('# 归档\n\n- [x] newest\n  - [x] newest child\n');
    expect(result).toContain('- [x] previous\n  body\n- [x] oldest\n\narchive note\n');
    expect(result.indexOf('- [x] newest')).toBeLessThan(result.indexOf('- [x] previous'));
    expect(normalize(result)).toBe(result);
  });
  it('stably places completed children below unfinished siblings with their entire subtree', () => {
    const source = '# 工作\n\n- [ ] root\n  - [x] previous\n    body\n    - [x] descendant\n  - [ ] first open\n  - [x] oldest\n  - [ ] second open\n\n# 笔记\n\nkeep exactly\n';
    const result = normalize(source);
    expect(result).toBe('# 工作\n\n- [ ] root\n  - [ ] first open\n  - [ ] second open\n  - [x] previous\n    body\n    - [x] descendant\n  - [x] oldest\n\n# 笔记\n\nkeep exactly\n');
    expect(parseDocument(result).tasks).toHaveLength(6);
    expect(normalize(result)).toBe(result);
  });
  it('records completion order by placing each newly completed child first in the completed sibling group', () => {
    const initial = '- [ ] root\n  - [ ] first\n    first body\n  - [ ] second\n  - [x] previous\n';
    const complete = (source: string, title: string): string => {
      const model = parseDocument(source);
      const item = model.tasks.find(task => source.slice(task.contentFrom, task.firstLineTo) === title)!;
      const checked = apply(source, taskToggleChanges(model, item.from));
      return normalize(checked, [item.from]);
    };
    const first = complete(initial, 'first');
    expect(first).toBe('- [ ] root\n  - [ ] second\n  - [x] first\n    first body\n  - [x] previous\n');
    const second = complete(first, 'second');
    expect(second).toBe('- [ ] root\n  - [x] second\n  - [x] first\n    first body\n  - [x] previous\n');
    expect(normalize(second)).toBe(second);
    expect(normalize(second.replace('- [ ] root', '- [x] root'))).toBe('# 归档\n\n- [x] root\n  - [x] second\n  - [x] first\n    first body\n  - [x] previous\n');
  });
  it('preserves quoted CRLF task topology while moving a newly completed child below unfinished siblings', () => {
    const source = '> - [ ] root\r\n>   - [x] newest\r\n>     body\r\n>   - [ ] open\r\n>   - [x] previous\r\n';
    const model = parseDocument(source);
    const result = normalize(source, [model.tasks[1].from]);
    expect(result).toBe('> - [ ] root\r\n>   - [ ] open\r\n>   - [x] newest\r\n>     body\r\n>   - [x] previous\r\n');
    expect(parseDocument(result).tasks).toHaveLength(4);
    expect(normalize(result)).toBe(result);
  });
  it('keeps an imported checked child with unfinished descendants in the unfinished sibling group', () => {
    const source = '- [ ] root\n  - [x] unfinished group\n    - [ ] descendant\n  - [x] finished\n  - [ ] open\n';
    expect(normalize(source)).toBe('- [ ] root\n  - [x] unfinished group\n    - [ ] descendant\n  - [ ] open\n  - [x] finished\n');
  });
  it('restores an archived nested task with its whole group and retains completed siblings', () => {
    const source = '- [ ] work\n\n# 归档\n\n- [x] root\n  - [x] parent\n    - [x] restored\n    - [x] completed sibling\n  - [x] completed uncle\n- [x] other archive\n';
    const model = parseDocument(source);
    const restored = model.tasks.find(task => source.slice(task.contentFrom, task.firstLineTo) === 'restored')!;
    const result = normalize(apply(source, taskToggleChanges(model, restored.from)));
    expect(result).toContain('- [ ] root\n  - [ ] parent\n    - [ ] restored\n    - [x] completed sibling\n  - [x] completed uncle\n');
    expect(result.indexOf('- [ ] root')).toBeLessThan(result.indexOf('# 归档'));
    expect(result).toContain('# 归档\n\n- [x] other archive\n');
    expect(normalize(result)).toBe(result);
  });
  it('merges repeated archive sections at EOF and preserves their non-task content', () => {
    const result = normalize('# 归档\n\nnote one\n\n- [x] a\n\n# 工作\n\n- [ ] b\n\n# 归档\n\nnote two\n\n- [x] c\n');
    expect(result.match(/^# 归档$/gm)).toHaveLength(1);
    expect(result.indexOf('# 工作')).toBeLessThan(result.indexOf('# 归档'));
    expect(result).toContain('note one');
    expect(result).toContain('note two');
    expect(normalize(result)).toBe(result);
  });
  it('recognizes only syntax-level root archive headings', () => {
    const source = '```md\n# 归档\n```\n\n> # 归档\n\n- item\n\n  # 归档\n\n## 归档\n\n# 归档\n\n- [x] real\n\n# 其他\n';
    const sections = archiveSections(parseDocument(source));
    expect(sections).toHaveLength(1);
    expect(source.slice(sections[0].from, sections[0].headingTo)).toBe('# 归档\n');
    expect(source.slice(sections[0].to)).toBe('# 其他\n');
  });
  it('keeps CRLF and handles a task without a final newline', () => {
    const result = normalize('- [ ] open\r\n- [x] done');
    expect(result).toBe('- [ ] open\r\n\r\n# 归档\r\n\r\n- [x] done');
    expect(result.replaceAll('\r\n', '')).not.toContain('\n');
    expect(normalize(result)).toBe(result);
  });
  it('does not touch documents without completed tasks and retains an empty archive', () => {
    expect(normalize('- [ ] only')).toBe('- [ ] only');
    const result = normalize('# 归档\n\n- [ ] restored\n');
    expect(result).toContain('- [ ] restored\n\n# 归档');
    expect(normalize(result)).toBe(result);
  });
  it('keeps an ordinary parent and its open sibling when a completed child shares the parent line', () => {
    const result = normalize('- - [x] done\n  - [ ] child\n- [ ] next\n');
    expect(result).toContain('- \n  - [ ] child\n- [ ] next');
    expect(result).toContain('# 归档\n\n- [x] done');
    expect(normalize(result)).toBe(result);
  });
  it.each(['```md\nunfinished code', '<!--\nunfinished comment', '<script>\nunfinished script'])('preserves the source when its trailing unclosed block would swallow the archive: %s', block => {
    const source = '- [x] completed\n\n' + block;
    expect(normalize(source)).toBe(source);
    expect(normalizeArchiveChanges(parseDocument(source))).toEqual([]);
  });
  it('preserves quote prefixes and keeps moved quote tasks parseable', () => {
    const source = '> - [x] quoted\n>   body\n>   - [x] child\n\n- [ ] open\n';
    const result = normalize(source);
    expect(result).toContain('# 归档\n\n> - [x] quoted\n>   body\n>   - [x] child');
    expect(parseDocument(result).tasks).toHaveLength(3);
    expect(normalize(result)).toBe(result);
  });
});
