/** 文件职责：验收同步分段写入的批次划分规则：何处逐段出现、何处一次写入、切点边界。 */
import { describe, expect, it } from 'vitest';
import { planSyncSteps, type SyncEdit } from './sync-stream';

const insert = (from: number, text: string): SyncEdit => ({ from, to: from, insert: text });
const remove = (from: number, to: number): SyncEdit => ({ from, to, insert: '' });
const filler = '正文'.repeat(200);

describe('同步分段写入', () => {
  it('阅读位置下方的行内插入按字符块分批，且每段落在同一插入点', () => {
    const steps = planSyncSteps([insert(100, '同一段里逐个出现的补充文字')], 60, filler);
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.flat().every(step => step.from === 100 && step.to === 100)).toBe(true);
    expect(steps.flat().map(step => step.insert).join('')).toBe('同一段里逐个出现的补充文字');
  });

  it('阅读位置及上方的差异与首个批次一次写入', () => {
    const steps = planSyncSteps([remove(10, 20), insert(30, '段内补充的文字内容')], 60, filler);
    expect(steps).toEqual([[remove(10, 20), insert(30, '段内补充的文字内容')]]);
  });

  it('行首插入整段写入：逐字出现会让行首前缀先降级再恢复', () => {
    const text = '正文'.repeat(50) + '\n' + '内容'.repeat(50);
    const lineStart = '正文'.repeat(50).length + 1;
    expect(planSyncSteps([insert(lineStart, '行首补充的一句话文字')], 0, text)).toEqual([[insert(lineStart, '行首补充的一句话文字')]]);
  });

  it('字符块边界不切开代理对', () => {
    const emoji = '😀'.repeat(6);
    const pieces = planSyncSteps([insert(10, emoji)], 0, filler).flat().map(step => step.insert);
    expect(pieces.join('')).toBe(emoji);
    for (const piece of pieces) expect(piece.length % 2).toBe(0);
  });
});
