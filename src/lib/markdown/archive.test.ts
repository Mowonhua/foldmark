import { describe, expect, it } from 'vitest';
import { parseDocument } from './parse';
import { archiveSections, normalizeArchiveChanges } from './archive';
import { taskToggleChanges } from './transactions';
import type { TextChange } from './types';
import { searchTasks } from './projection';

const apply = (text: string, changes: TextChange[]): string => [...changes].sort((left, right) => right.from - left.from).reduce((result, change) => result.slice(0, change.from) + change.insert + result.slice(change.to), text);
const normalize = (text: string, completedFrom: readonly number[] = []): string => apply(text, normalizeArchiveChanges(parseDocument(text), completedFrom));

describe('managed archive layout', () => {
  it('已有归档中的一级标题移除，但直属正文、任务和二级子路径保留', () => {
    const source = '# 项目\n\n## 本周\n\n- [ ] open\n\n# 归档\n<!-- foldmark:archive -->\n\n# 项目\n\n归档备注\n\n- [x] direct\n\n## 本周\n\n### 开发\n\n- [x] nested\n\n# 其他\n\n- [x] other\n';
    const result = normalize(source);
    const archived = result.slice(archiveSections(parseDocument(result))[0].headingTo);
    expect(archived).not.toMatch(/^# /m);
    expect(archived).toContain('归档备注');
    expect(archived).toContain('- [x] direct');
    expect(archived).toContain('- [x] other');
    expect(archived).toContain('## 本周\n\n### 开发\n\n- [x] nested');
    expect(parseDocument(result).tasks).toHaveLength(4);
    expect(normalize(result)).toBe(result);
  });
  it('一级标题结束前一二级标题的作用域，直属任务不归入前一章节', () => {
    const result = normalize('# 甲\n\n## 本周\n\n- [x] headed\n\n# 乙\n\n- [x] direct\n');
    const model = parseDocument(result);
    expect(searchTasks(model, 'direct', true)[0].heading).toBe('归档');
    expect(searchTasks(model, 'headed', true)[0].heading).toBe('本周');
    expect(normalize(result)).toBe(result);
  });
  it('省略不同一级章节后，跳级的顶层路径不被前一标题吸收，恢复也不串组', () => {
    const result = normalize('# A\n\n## X\n\n- [x] a\n\n# B\n\n### Y\n\n- [x] b\n');
    const model = parseDocument(result);
    const archived = result.slice(archiveSections(model)[0].headingTo);
    expect(archived.indexOf('### Y')).toBeLessThan(archived.indexOf('## X'));
    const task = model.tasks.find(item => result.slice(item.contentFrom, item.firstLineTo) === 'b')!;
    const restored = normalize(apply(result, taskToggleChanges(model, task.from)));
    expect(restored).toContain('# B\n\n### Y\n\n- [ ] b');
    expect(restored.slice(0, restored.indexOf('# B'))).not.toContain('- [ ] b');
    expect(normalize(result)).toBe(result);
    expect(normalize(restored)).toBe(restored);
    const legacy = normalize('# 归档\n<!-- foldmark:archive -->\n\n# A\n\n## X\n\n- [x] a\n\n# B\n\n### Y\n\n- [x] b\n');
    expect(legacy.indexOf('### Y')).toBeLessThan(legacy.indexOf('## X'));
    expect(normalize(legacy)).toBe(legacy);
  });
  it('归档镜像完整标题路径，同路径的新任务前插且重新打开不丢层级', () => {
    const source = '# 工作\n\n## 本周\n\n### 开发\n\n- [x] first\n- [ ] second\n\n## 其他\n\n- [ ] untouched\n';
    const first = normalize(source);
    const section = archiveSections(parseDocument(first))[0];
    expect(first.slice(section.headingTo)).toContain('## 本周\n\n### 开发\n\n- [x] first');
    const second = normalize(first.replace('- [ ] second', '- [x] second'));
    const archived = second.slice(archiveSections(parseDocument(second))[0].headingTo);
    expect(archived).not.toMatch(/^# 工作$/m);
    expect(archived.match(/^## 本周$/gm)).toHaveLength(1);
    expect(archived.match(/^### 开发$/gm)).toHaveLength(1);
    expect(archived.indexOf('second')).toBeLessThan(archived.indexOf('first'));
    expect(normalize(second)).toBe(second);
    expect(second.indexOf('untouched')).toBeLessThan(second.indexOf('# 归档'));
  });
  it('二级至六级与跳级标题保留原级别，不生成七级标题', () => {
    const headings = Array.from({ length: 6 }, (_, index) => '#'.repeat(index + 1) + ' level ' + (index + 1)).join('\n\n');
    const result = normalize(headings + '\n\n- [x] deep\n');
    expect(result.slice(archiveSections(parseDocument(result))[0].headingTo)).toContain(headings.split('\n\n').slice(1).join('\n\n'));
    expect(result).not.toContain('#######');
    expect(normalize(result)).toBe(result);
    const skipped = normalize('# 根\n\n#### 深层\n\n- [x] skipped\n');
    expect(skipped.slice(archiveSections(parseDocument(skipped))[0].headingTo)).toContain('#### 深层');
    expect(skipped.slice(archiveSections(parseDocument(skipped))[0].headingTo)).not.toContain('# 根');
  });
  it('不同祖先和重复同名兄弟章节不串组', () => {
    const source = '# 甲\n\n## 重名\n\n- [x] a\n\n# 乙\n\n## 重名\n\n- [x] b\n\n# 丙\n\n## 重名\n\n- [x] c\n\n## 重名\n\n- [x] d\n';
    const result = normalize(source);
    const archived = result.slice(archiveSections(parseDocument(result))[0].headingTo);
    expect(archived).not.toMatch(/^# /m);
    expect(archived.match(/^## 重名$/gm)).toHaveLength(4);
    expect(archived).toMatch(/## 重名\n\n- \[x\] a/);
    expect(archived).toMatch(/## 重名\n\n- \[x\] b/);
    expect(archived).toMatch(/## 重名\n\n- \[x\] c\n\n## 重名\n\n- \[x\] d/);
    expect(normalize(result)).toBe(result);
  });
  it('无标题任务保持归档直属，引用和任务正文标题不污染兄弟任务路径', () => {
    const source = '- [x] unheaded\n\n# 工作\n\n> ## 引用标题\n\n- [ ] open\n\n  ## 任务正文标题\n\n- [x] sibling\n';
    const result = normalize(source);
    const archived = result.slice(archiveSections(parseDocument(result))[0].headingTo);
    expect(archived.indexOf('unheaded')).toBeLessThan(archived.indexOf('sibling'));
    expect(archived).toContain('- [x] sibling');
    expect(archived).not.toContain('# 工作');
    expect(archived).not.toContain('引用标题');
    expect(archived).not.toContain('任务正文标题');
    expect(normalize(result)).toBe(result);
  });
  it('Setext、内联标题格式、CRLF 与无末尾换行随标题路径保留', () => {
    const source = '**工作**\r\n===\r\n\r\n**本周**\r\n---\r\n\r\n- [x] done';
    const result = normalize(source);
    expect(result.slice(archiveSections(parseDocument(result))[0].headingTo)).toContain('**本周**\r\n---\r\n\r\n- [x] done');
    expect(result.slice(archiveSections(parseDocument(result))[0].headingTo)).not.toContain('**工作**');
    expect(result.replaceAll('\r\n', '')).not.toContain('\n');
    expect(normalize(result)).toBe(result);
  });
  it('多个归档章节之间补分隔时沿用 CRLF，不能产生裸 LF', () => {
    const result = normalize('# 项目\r\n\r\n## A\r\n\r\n- [x] a\r\n\r\n## B\r\n\r\n- [x] b\r\n');
    expect(result.replaceAll('\r\n', '')).not.toContain('\n');
    expect(normalize(result)).toBe(result);
  });
  it('恢复完整任务组到原标题下，其他章节正文不变', () => {
    const initial = '# 工作\n\n## 开发\n\n- [x] parent\n  body\n  - [x] child\n\n# 笔记\n\nkeep exactly\n';
    const archived = normalize(initial);
    const model = parseDocument(archived);
    const parent = model.tasks.find(item => archived.slice(item.contentFrom, item.firstLineTo) === 'parent')!;
    const result = normalize(apply(archived, taskToggleChanges(model, parent.from)));
    expect(result).toContain('## 开发\n\n- [ ] parent\n  body\n  - [x] child');
    expect(result.indexOf('parent')).toBeLessThan(result.indexOf('# 笔记'));
    expect(result).toContain('# 笔记\n\nkeep exactly\n');
    expect(normalize(result)).toBe(result);
  });
  it('原标题已删除时恢复重建路径，含多个原有归档分区时仍保留工作章节', () => {
    const archived = normalize('# 工作\n\n## 开发\n\n- [x] done\n');
    const withoutActive = archived.slice(archived.indexOf('# 归档'));
    const result = normalize(withoutActive.replace('- [x] done', '- [ ] done'));
    expect(result).toMatch(/^## 开发\n\n- \[ \] done/);
    expect(result.indexOf('done')).toBeLessThan(result.indexOf('# 归档'));
    const mixed = normalize('# 归档\n\n- [x] old\n\n# 工作\n\n- [ ] open\n- [x] new\n');
    expect(mixed.indexOf('open')).toBeLessThan(mixed.indexOf('# 归档'));
    expect(mixed.slice(archiveSections(parseDocument(mixed))[0].headingTo)).toContain('- [x] new');
    expect(mixed.slice(archiveSections(parseDocument(mixed))[0].headingTo)).not.toContain('# 工作');
    expect(mixed).toContain('- [x] old');
    expect(normalize(mixed)).toBe(mixed);
  });
  it('合并旧归档分区时，无标题任务不挂到前一分区的标题下', () => {
    const result = normalize('# 归档\n\n## 已有章节\n\n- [x] headed\n\n# 工作\n\n- [ ] open\n\n# 归档\n\n- [x] unheaded\n');
    expect(searchTasks(parseDocument(result), 'unheaded', true)[0].heading).toBe('归档');
    expect(searchTasks(parseDocument(result), 'headed', true).find(task => task.title === 'headed')!.heading).toBe('已有章节');
    expect(normalize(result)).toBe(result);
  });
  it('恢复无末尾换行的深层任务时，不吞掉后续章节标题和正文', () => {
    const source = '# A\n\n## B\n\n# Other\n\nuntouched prose\n\n# 归档\n<!-- foldmark:archive -->\n\n# A\n\n## B\n\n- [ ] restored';
    const result = normalize(source);
    expect(result).toContain('## B\n\n- [ ] restored\n\n# Other\n\nuntouched prose');
    expect(parseDocument(result).headings.some(heading => heading.text === 'Other')).toBe(true);
    expect(searchTasks(parseDocument(result), 'restored')[0].title).toBe('restored');
    expect(normalize(result)).toBe(result);
  });
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
