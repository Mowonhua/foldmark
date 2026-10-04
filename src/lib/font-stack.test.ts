/** 文件职责：验证字体栈解析与组合的往返一致、非法输入容错及字体可用性探测。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeFontStack, DEFAULT_FONT_STACK, parseFontStack, probeFontInstalled, quoteFontFamily, resetProbeCache } from './font-stack';

describe('字体栈解析', () => {
  it('默认字体栈解析为三个槽位并精确往返', () => {
    const slots = parseFontStack(DEFAULT_FONT_STACK);
    expect(slots.named).toEqual(['Microsoft YaHei', 'PingFang SC']);
    expect(slots.generic).toBe('sans-serif');
    expect(composeFontStack(slots.named, slots.generic)).toBe(DEFAULT_FONT_STACK);
  });

  it('未加引号的裸名序列合并为单个族名', () => {
    const slots = parseFontStack('LXGW WenKai Mono GB Medium, sans-serif');
    expect(slots.named).toEqual(['LXGW WenKai Mono GB Medium']);
    expect(slots.generic).toBe('sans-serif');
    expect(composeFontStack(slots.named, slots.generic)).toBe('"LXGW WenKai Mono GB Medium", sans-serif');
  });

  it('通用关键字大小写不敏感且只保留最后一个', () => {
    expect(parseFontStack('SANS-SERIF').generic).toBe('sans-serif');
    expect(parseFontStack('"A", monospace, serif').generic).toBe('serif');
    expect(parseFontStack('"A", monospace, serif').named).toEqual(['A']);
  });

  it('空段与空白被跳过，空输入得到空槽位', () => {
    expect(parseFontStack('  "A" ,  , serif ')).toEqual({ named: ['A'], generic: 'serif' });
    expect(parseFontStack('')).toEqual({ named: [], generic: null });
    expect(parseFontStack('   ')).toEqual({ named: [], generic: null });
  });
});

describe('字体栈组合', () => {
  it('具名字体一律加引号并转义内部引号与反斜杠', () => {
    expect(quoteFontFamily('A "B" \\C')).toBe('"A \\"B\\" \\\\C"');
    expect(composeFontStack(['A "B"'], null)).toBe('"A \\"B\\""');
  });

  it('兜底关键字裸写并位于栈尾', () => {
    expect(composeFontStack([], 'sans-serif')).toBe('sans-serif');
    expect(composeFontStack(['A', 'B'], 'monospace')).toBe('"A", "B", monospace');
  });

  it('空具名字体被过滤', () => {
    expect(composeFontStack(['A', '  '], null)).toBe('"A"');
  });
});

describe('非法输入容错', () => {
  it('未闭合引号按到字符串末尾处理，重组后成为合法栈', () => {
    const slots = parseFontStack('"Microsoft YaHei, sans-serif');
    expect(slots.named).toEqual(['Microsoft YaHei, sans-serif']);
    expect(composeFontStack(slots.named, slots.generic)).toBe('"Microsoft YaHei, sans-serif"');
  });

  it('引号内逗号不拆分族名', () => {
    expect(parseFontStack('"A, B", serif').named).toEqual(['A, B']);
  });

  it('转义引号还原为字面引号', () => {
    expect(parseFontStack('"A \\"B\\"", serif').named).toEqual(['A "B"']);
  });
});

describe('字体可用性探测', () => {
  afterEach(() => {
    resetProbeCache();
    vi.restoreAllMocks();
  });

  function mockMeasureWidths(controlWidth: number, namedWidth: number): void {
    let currentFont = '';
    const measureText = vi.fn(() => ({ width: currentFont.includes('"') ? namedWidth : controlWidth }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      get font() { return currentFont; },
      set font(value: string) { currentFont = value; },
      measureText
    } as unknown as CanvasRenderingContext2D);
  }

  it('宽度偏离对照栈的字体判定为已安装', () => {
    mockMeasureWidths(100, 137);
    expect(probeFontInstalled('示例字体 Alpha')).toBe(true);
  });

  it('与两个对照栈都等宽的字体判定为缺失', () => {
    mockMeasureWidths(100, 100);
    expect(probeFontInstalled('示例字体 Beta')).toBe(false);
  });

  it('通用关键字恒为可用，不触发测量', () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    expect(probeFontInstalled('sans-serif')).toBe(true);
    expect(getContext).not.toHaveBeenCalled();
  });

  it('探测结果按族名缓存', () => {
    const measure = vi.fn().mockReturnValueOnce({ width: 100 }).mockReturnValueOnce({ width: 137 }).mockReturnValue({ width: 100 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: measure,
      font: ''
    } as unknown as CanvasRenderingContext2D);
    expect(probeFontInstalled('示例字体 Gamma')).toBe(true);
    const firstCalls = measure.mock.calls.length;
    expect(probeFontInstalled('示例字体 Gamma')).toBe(true);
    expect(measure.mock.calls.length).toBe(firstCalls);
  });

  it('无法创建画布时保守判定为缺失', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(probeFontInstalled('示例字体 Delta')).toBe(false);
  });
});
