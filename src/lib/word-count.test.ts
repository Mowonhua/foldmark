/** 文件职责：验证字数统计对中英文、数字、标点、Markdown 标记与 Emoji 的计数口径。 */
import { describe, expect, it } from 'vitest';
import { countWords } from './word-count';

describe('字数统计', () => {
  it('汉字逐字计数，忽略中英文标点与空白', () => {
    expect(countWords('你好，世界！')).toBe(4);
    expect(countWords('Hello, world!')).toBe(2);
    expect(countWords('中文 😀 English')).toBe(4);
  });

  it('连续字母、数字及混合串各按一个词计数', () => {
    expect(countWords('abc123 DEF456')).toBe(2);
    expect(countWords('版本 v1 和 2026 发布')).toBe(7);
    expect(countWords('中文abc中文')).toBe(5);
    expect(countWords('２０２６')).toBe(1);
  });

  it('英文词内部的撇号和连字符不拆词', () => {
    expect(countWords("don't state-of-the-art")).toBe(2);
  });

  it('Markdown 标记和各类符号不计入字数', () => {
    expect(countWords('# 标题\n\n- [ ] 待办\n- [x] 已完成')).toBe(8);
    expect(countWords('——……《》「」()[]{}<>+-=*/\\|~`\'"')).toBe(0);
  });

  it('Emoji 组合序列按一个字符计数，空文本为零', () => {
    expect(countWords('👨‍👩‍👧‍👦 🇨🇳 👍🏽')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});
