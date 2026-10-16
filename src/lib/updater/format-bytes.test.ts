/** 文件职责：验证字节数可读格式化的单位选择与非正常输入回退。 */
import { describe, expect, it } from 'vitest';
import { formatBytes } from './format-bytes';

describe('字节格式化', () => {
  it('按 1024 进制选择最大可读单位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(12.34 * 1024 * 1024)).toBe('12.3 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
  });

  it('非有限与负数输入按 0 处理', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });
});
