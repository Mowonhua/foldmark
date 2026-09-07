import { describe, expect, it } from 'vitest';
import { parseDocument } from './parse';
import { archiveSections, normalizeArchiveChanges } from './archive';

const normalize = (text: string): string => normalizeArchiveChanges(parseDocument(text)).reduceRight((result, change) => result.slice(0, change.from) + change.insert + result.slice(change.to), text);

describe('managed archive layout', () => {
  it('moves completed subtrees to the final archive and preserves unrelated prose', () => {
    const source = '# 工作\n\n- [ ] open\n- [x] done\n  body\n  - [x] child\n\n# 笔记\n\nkeep exactly\n';
    const result = normalize(source);
    expect(result).toContain('# 工作\n\n- [ ] open\n\n# 笔记\n\nkeep exactly\n');
    expect(result).toMatch(/# 归档\n\n- \[x\] done\n  body\n  - \[x\] child\n$/);
    expect(normalize(result)).toBe(result);
  });
  it('promotes completed nested tasks without changing body indentation relative to the task', () => {
    const result = normalize('- [ ] parent\n  - [x] child\n\n    paragraph\n\n    ```ts\n    code\n    ```\n  - [ ] sibling\n');
    expect(result).toContain('- [ ] parent\n  - [ ] sibling');
    expect(result).toContain('# 归档\n\n- [x] child\n\n  paragraph\n\n  ```ts\n  code\n  ```');
    expect(normalize(result)).toBe(result);
  });
  it('restores incomplete archive subtrees and leaves their completed children archived', () => {
    const result = normalize('- [ ] work\n\n# 归档\n\n- [x] parent\n  - [ ] restored\n  - [x] finished\n');
    expect(result.indexOf('- [x] parent')).toBeLessThan(result.indexOf('# 归档'));
    expect(result.indexOf('  - [ ] restored')).toBeLessThan(result.indexOf('# 归档'));
    expect(result).toMatch(/# 归档\n\n- \[x\] finished\n$/);
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
