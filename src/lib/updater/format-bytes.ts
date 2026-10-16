/**
 * 文件职责：把字节数格式化为紧凑的可读文本。
 * 定义范围：更新面板与底部状态栏共用的体积、速度展示；不处理翻译。
 */
const units = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * 函数职责：按 1024 进制选择最大可读单位并保留一位小数。
 * 输入说明：字节数为非负有限数；非有限输入按 0 处理。
 * 输出说明：不足 1 KB 时保留整数 B；其余单位统一一位小数，便于等宽对齐。
 */
export function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  let value = safe;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
