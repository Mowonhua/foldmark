/**
 * 文件职责：验证任务语义、完整源文事务及视图边界。
 * 定义范围：语法节点识别、完成恢复、排序缩进和可靠身份的行为测试。
 */
import { describe, expect, it } from 'vitest';
import { parseDocument, taskToggleChanges, moveItemChanges, moveItemPosition, indentItemChanges, getHiddenRanges, searchTasks, foldKey, type TextChange } from './index';
const apply = (text: string, changes: TextChange[]): string => [...changes].sort((a,b)=>b.from-a.from).reduce((s,c)=>s.slice(0,c.from)+c.insert+s.slice(c.to),text);

describe('shared syntax model', () => {
  it('recognizes actual tasks, with full paragraphs and nested item boundaries', () => {
    const text = '# Plan\n\n- [ ] parent\n\n  paragraph\n\n  - [x] child\n- ordinary\n\nindependent\n';
    const m = parseDocument(text);
    expect(m.items).toHaveLength(3); expect(m.tasks).toHaveLength(2);
    expect(m.tasks[0].children).toEqual([m.tasks[1].from]);
    expect(text.slice(m.tasks[0].from,m.tasks[0].to)).toContain('paragraph');
    expect(text.slice(m.tasks[0].from,m.tasks[0].to)).not.toContain('ordinary');
    expect(m.headings[0].text).toBe('Plan');
  });
  it('ignores fake tasks in code, inline code, and closed or unclosed math blocks', () => {
    const m = parseDocument('```md\n- [ ] code\n```\n\n`- [ ] inline`\n\n$$\n- [ ] math\n$$\n\n- [ ] real\n\n$$\n- [ ] unfinished');
    expect(m.tasks).toHaveLength(1); expect(m.text.slice(m.tasks[0].contentFrom,m.tasks[0].firstLineTo)).toBe('real');
    const names: string[]=[];m.tree.iterate({enter:n=>{names.push(n.name)}});expect(names.filter(n=>n==='MathBlock')).toHaveLength(2);
  });
  it('keeps CRLF outside first line and raw source untouched', () => {
    const text='- [ ] ~~still open~~\r\n  body\r\n- [X] done\r\n';const m=parseDocument(text);
    expect(text.slice(0,m.items[0].firstLineTo)).toBe('- [ ] ~~still open~~');
    expect(m.items[0].task?.checked).toBe(false);expect(m.items[1].task?.checked).toBe(true);
  });
});
describe('task transactions', () => {
  it('requires explicit group completion and only edits checkbox characters', () => {
    const text='- [ ] parent\n  - [ ] child\n  - [x] done\n\n# untouched';const m=parseDocument(text);
    expect(()=>taskToggleChanges(m,0)).toThrow('TASK_GROUP_REQUIRED');
    const changes=taskToggleChanges(m,0,true);expect(changes).toHaveLength(2);expect(changes.every(c=>c.to-c.from===1)).toBe(true);
    expect(apply(text,changes)).toBe(text.replaceAll('[ ]','[x]'));
  });
  it('restores ancestors in the same transaction but does not auto-complete parents', () => {
    const m=parseDocument('- [x] parent\n  - [x] child');const changes=taskToggleChanges(m,m.tasks[1].from);
    expect(apply(m.text,changes)).toBe('- [ ] parent\n  - [ ] child');
    const open=parseDocument('- [ ] parent\n  - [ ] child');expect(taskToggleChanges(open,open.tasks[1].from)).toHaveLength(1);
  });
});
describe('structure edits', () => {
  it('moves full content including hidden descendants and retains outside source and CRLF', () => {
    const text='# A\r\n\r\n- [ ] first\r\n\r\n  prose\r\n\r\n  ```\r\n  code\r\n  ```\r\n\r\n  - [x] nested\r\n- [ ] second\r\n\r\n# B\r\n';const m=parseDocument(text);const first=m.tasks[0], second=m.tasks[2];
    const moved=apply(text,moveItemChanges(m,first.from,null));expect(moved).toBe('# A\r\n\r\n- [ ] second\r\n- [ ] first\r\n\r\n  prose\r\n\r\n  ```\r\n  code\r\n  ```\r\n\r\n  - [x] nested\r\n\r\n# B\r\n');
    const mapped=moveItemPosition(m,first.from,null,first.contentFrom);expect(moved.slice(mapped,mapped+5)).toBe('first');expect(parseDocument(moved).tasks).toHaveLength(3);
    expect(()=>moveItemChanges(m,first.from,m.tasks[1].from)).toThrow('INVALID_MOVE');expect(second.parentFrom).toBe(null);
  });
  it('handles moving EOF without newline and rejects separate lists', () => {
    const m=parseDocument('- one\n- two');expect(apply(m.text,moveItemChanges(m,m.items[1].from,0))).toBe('- two\n- one\n');
    const separate=parseDocument('- one\n\n# section\n\n- other');expect(()=>moveItemChanges(separate,0,separate.items[1].from)).toThrow('INVALID_MOVE');
  });
  it('moves nested siblings without losing indentation', () => {
    const m=parseDocument('- root\n  - one\n    continuation\n  - two\n- next\n');expect(apply(m.text,moveItemChanges(m,m.items[2].from,m.items[1].from))).toBe('- root\n  - two\n  - one\n    continuation\n- next\n');
  });
  it('indents the whole item according to ordered marker width and safely outdents', () => {
    const m=parseDocument('10. first\n11. second\n    body\n');const indented=apply(m.text,indentItemChanges(m,m.items[1].from,1));expect(indented).toBe('10. first\n    11. second\n        body\n');
    const next=parseDocument(indented);expect(apply(indented,indentItemChanges(next,next.items[1].from,-1))).toBe(m.text);expect(indentItemChanges(m,m.items[0].from,1)).toEqual([]);
  });
});
describe('projection and discovery', () => {
  it('hides only completed subtrees, retaining independent text', () => {
    const m=parseDocument('# work\n\n- [ ] parent\n  - [x] done\n  - [ ] open\n\nindependent\n');const ranges=getHiddenRanges(m,'todo');expect(ranges).toHaveLength(1);expect(ranges[0].parentFrom).toBe(m.tasks[0].from);expect(m.text.slice(ranges[0].from,ranges[0].to)).toBe('  - [x] done\n');
    expect(getHiddenRanges(m,'source')).toEqual([]);
  });
  it('archive retains the ancestor path and completed subtree without duplicate descendants', () => {
    const m=parseDocument('# work\n\n- [ ] parent\n  unrelated\n  - [x] done\n    archived body\n  - [ ] open\n\nindependent\n');const visible=apply(m.text,getHiddenRanges(m,'archive').map(r=>({...r,insert:''})));
    expect(visible).toContain('# work');expect(visible).toContain('- [ ] parent');expect(visible).toContain('archived body');expect(visible).not.toContain('unrelated');expect(visible).not.toContain('open');expect(visible).not.toContain('independent');
  });
  it('search shares ancestor completion and section semantics and ignores folded state', () => {
    const m=parseDocument('# work\n\n- [x] parent\n  - [ ] hidden child\n- [ ] active child');expect(searchTasks(m,'child',false)).toHaveLength(1);expect(searchTasks(m,'hidden',true).at(-1)?.heading).toBe('work');expect(searchTasks(m,'active child',false)[0].title).toBe('active child');
  });
  it('fold keys follow unique unchanged text and decline ambiguous duplicates', () => {
    const m=parseDocument('- one\n  body\n- two\n');const key=foldKey(m,m.items[0]);const moved=parseDocument(apply(m.text,moveItemChanges(m,0,null)));expect(foldKey(moved,moved.items[1])).toBe(key);
    const duplicate=parseDocument('- same\n- same\n');expect(foldKey(duplicate,duplicate.items[0])).toBe('');
  });
});

// 独立边界场景覆盖外部编辑也可能产生的合法 CommonMark 结构。
describe('structural edge cases', () => {
  it('does not swallow a following sibling after an unclosed nested math block', () => {
    const m=parseDocument('- [ ] parent\n\n  $$\n  - [ ] formula\n- [ ] sibling\n');
    expect(m.tasks.map(item=>m.text.slice(item.contentFrom,item.firstLineTo))).toEqual(['parent','sibling']);
  });
  it('does not match an archived descendant through its active parent', () => {
    const m=parseDocument('- [ ] parent\n  - [x] hidden token\n  - [ ] active token\n');
    expect(searchTasks(m,'hidden',false)).toHaveLength(0);expect(searchTasks(m,'active',false).map(result=>result.title)).toEqual(['active token']);
  });
  it('rejects moving a nested item sharing its physical line with its parent', () => {
    const m=parseDocument('- - one\n  - two\n');expect(()=>moveItemChanges(m,m.items[1].from,null)).toThrow('INVALID_MOVE');
  });
  it('preserves a loose list when its last item moves before a preceding item', () => {
    const m=parseDocument('- one\n\n- two\n');const next=parseDocument(apply(m.text,moveItemChanges(m,m.items[1].from,0)));
    expect(next.text).toBe('- two\n\n- one\n\n');
  });
});
