import { describe, expect, it } from 'vitest';
import { parseDocument } from './parse';
import { getHiddenRanges } from './projection';
import { activeOutlineFrom, outlineEntries } from './outline';
import type { HiddenRange } from './types';

describe('outline entries', () => {
  it('待办页列归档章节前的标题，归档页列归档标题及其后续标题', () => {
    const model = parseDocument('# 工作\n\n## 任务A\n\n# 归档\n\n## 2024\n');
    const todo = outlineEntries(model, 'todo').map(entry => entry.text);
    const archive = outlineEntries(model, 'archive').map(entry => entry.text);
    expect(todo).toEqual(['工作', '任务A']);
    expect(archive).toEqual(['归档', '2024']);
  });

  it('无标记的归档章节在下一个一级标题处结束，其后内容回到待办区', () => {
    const model = parseDocument('# 归档\n\n## 旧\n\n# 其他\n\n## 近期\n');
    expect(outlineEntries(model, 'archive').map(entry => entry.text)).toEqual(['归档', '旧']);
    expect(outlineEntries(model, 'todo').map(entry => entry.text)).toEqual(['其他', '近期']);
  });

  it('托管标记让归档章节延伸到文件尾，其后一级标题仍属归档区', () => {
    const model = parseDocument('# 归档\n<!-- foldmark:archive -->\n\n## 旧\n\n# 其他\n');
    expect(outlineEntries(model, 'archive').map(entry => entry.text)).toEqual(['归档', '旧', '其他']);
    expect(outlineEntries(model, 'todo')).toEqual([]);
  });

  it('归档页中未随已完成组显示的标题不可见，待办页传入隐藏范围同样标注', () => {
    const source = '# 归档\n\n## 完成\n\n- [x] 任务一\n\n## 空\n\n正文\n';
    const model = parseDocument(source);
    const archive = outlineEntries(model, 'archive', getHiddenRanges(model, 'archive'));
    expect(archive.map(entry => [entry.text, entry.visible])).toEqual([['归档', true], ['完成', true], ['空', false]]);
    const hidden: HiddenRange[] = [{ from: 0, to: model.text.length, parentFrom: null, count: 0 }];
    expect(outlineEntries(model, 'todo', hidden).every(entry => !entry.visible)).toBe(true);
  });
});

describe('active outline heading', () => {
  const positions = [{ from: 1, top: 10 }, { from: 2, top: 50 }, { from: 3, top: 90 }];

  it('取视口顶部以上最后一个标题', () => {
    expect(activeOutlineFrom(positions, 60, new Set([1, 2, 3]))).toBe(2);
    expect(activeOutlineFrom(positions, 200, new Set([1, 2, 3]))).toBe(3);
  });

  it('视口顶部上方没有标题时回退首个标题', () => {
    expect(activeOutlineFrom(positions, 0, new Set([1, 2, 3]))).toBe(1);
  });

  it('候选不在当前列表时不高亮', () => {
    expect(activeOutlineFrom(positions, 60, new Set([1, 3]))).toBe(null);
    expect(activeOutlineFrom([], 60, new Set<number>())).toBe(null);
  });

  it('滚动到底时列表中最后一个标题即当前章节', () => {
    expect(activeOutlineFrom(positions, 60, new Set([1, 2, 3]), 60)).toBe(3);
    expect(activeOutlineFrom(positions, 60, new Set([1, 2]), 60)).toBe(2);
    expect(activeOutlineFrom(positions, 60, new Set<number>(), 60)).toBe(null);
  });
});
