/**
 * 文件职责：解析与组合 CSS 字体栈，探测字体可用性并提供字体列表。
 * 定义范围：fontFamily 字符串与选择器槽位的映射、canvas 探测、浏览器降级清单；不触碰持久化或编辑器。
 */
import { invoke, isTauri } from '@tauri-apps/api/core';

/** 结构职责：CSS 中无需引号的通用字体族关键字；约束条件：与 font-family 规范关键字保持一致。 */
export const GENERIC_FAMILIES = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui'] as const;
/** 结构职责：设置面板三个槽位共用的默认字体栈；约束条件：与 defaultPreferences.fontFamily 保持同源。 */
export const DEFAULT_FONT_STACK = '"Microsoft YaHei", "PingFang SC", sans-serif';

export interface FontStackSlots {
  /** 依出现顺序排列的具名字体；第一项为主字体，第二项为备用字体。 */
  named: string[];
  /** 栈尾的通用兜底关键字；缺省为 null 表示未声明兜底。 */
  generic: string | null;
}

/** 函数职责：判断族名是否为通用关键字。输入说明：任意族名；输出说明：大小写不敏感。 */
export function isGenericFamily(family: string): boolean {
  return (GENERIC_FAMILIES as readonly string[]).includes(family.toLowerCase());
}

/**
 * 函数职责：为具名字体生成可安全内联的 CSS font-family 片段。
 * 输入说明：单个族名，允许引号与反斜杠。
 * 输出说明：始终带双引号的转义字面量；通用关键字不应使用本函数。
 * 实现思路：反斜杠先转义再转义引号，保证任意输入都不破坏 CSS 语法。
 */
export function quoteFontFamily(family: string): string {
  return `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 函数职责：把选择器槽位组合回 CSS 字体栈字符串。
 * 输入说明：具名字体按栈序排列，generic 为栈尾关键字或 null。
 * 输出说明：具名字体一律加引号，通用关键字裸写；对默认值精确还原原字符串。
 */
export function composeFontStack(named: string[], generic: string | null): string {
  const families = named.filter((family) => family.trim() !== '').map(quoteFontFamily);
  if (generic) families.push(generic);
  return families.join(', ');
}

/** 函数职责：按顶层逗号切分字体栈；引号内的逗号与花括号内容视为族名的一部分。 */
function splitTopLevelFamilies(input: string): string[] {
  const families: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === '\\' && quote === '"' && input[index + 1]) {
        current += character + input[index + 1];
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ',') {
      families.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  families.push(current);
  return families;
}

/**
 * 函数职责：把 CSS 字体栈解析为选择器槽位。
 * 输入说明：任意用户输入，包括非法 CSS。
 * 输出说明：具名字体保留原顺序与原大小写；通用关键字只保留最后一个作为兜底，未闭合引号按到字符串末尾处理。
 * 实现思路：顶层逗号切分后逐项去引号并折叠空白；裸名序列（如 LXGW WenKai Mono GB Medium）本身就是一项。
 */
export function parseFontStack(input: string): FontStackSlots {
  const named: string[] = [];
  let generic: string | null = null;
  for (const token of splitTopLevelFamilies(input)) {
    const trimmed = token.trim();
    if (trimmed === '') continue;
    const quote = trimmed[0];
    let family: string;
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length > 1) {
      family = trimmed.slice(1, -1).replaceAll(`\\${quote}`, quote).replaceAll('\\\\', '\\');
    } else {
      family = trimmed.replaceAll(/["']/g, '');
    }
    family = family.trim().replaceAll(/\s+/g, ' ');
    if (family === '') continue;
    if (isGenericFamily(family)) generic = family.toLowerCase();
    else named.push(family);
  }
  return { named, generic };
}

/**
 * 函数职责：探测一个具名字体是否已安装。
 * 输入说明：单个族名；通用关键字恒为可用。
 * 输出说明：与对照字体栈宽度存在差异视为已安装；无法测量（如无 canvas）时保守返回 false。
 * 实现思路：分别以衬线与等宽对照渲染中英文测试串，缺失字体必然与其中一个对照等宽；结果按族名缓存。
 */
const probeCache = new Map<string, boolean>();
const PROBE_CONTROLS = ['monospace', 'serif'] as const;

export function probeFontInstalled(family: string): boolean {
  if (isGenericFamily(family)) return true;
  if (probeCache.has(family)) return probeCache.get(family)!;
  let installed = false;
  if (typeof document !== 'undefined') {
    const context = document.createElement('canvas').getContext('2d');
    if (context) {
      const text = 'foldmark 正文字体 0123';
      for (const control of PROBE_CONTROLS) {
        context.font = `72px ${control}`;
        const baseline = context.measureText(text).width;
        context.font = `72px ${quoteFontFamily(family)}, ${control}`;
        if (Math.abs(context.measureText(text).width - baseline) > 0.5) {
          installed = true;
          break;
        }
      }
    }
  }
  probeCache.set(family, installed);
  return installed;
}

/** 测试钩子：清空探测缓存，避免跨用例串扰。 */
export function resetProbeCache(): void {
  probeCache.clear();
}

/** 结构职责：浏览器模式的候选字体清单；约束条件：仅作为降级来源，桌面端以系统枚举为准。 */
export const CURATED_BROWSER_FONTS: readonly string[] = [
  // Windows
  'Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'FangSong', 'DengXian', 'Segoe UI', 'Consolas',
  'Cascadia Code', 'Arial', 'Calibri', 'Cambria', 'Times New Roman', 'Georgia', 'Verdana', 'Tahoma',
  'Trebuchet MS', 'Courier New', 'Comic Sans MS', 'Impact', 'Palatino Linotype',
  // macOS
  'PingFang SC', 'Hiragino Sans GB', 'Songti SC', 'Kaiti SC', 'STHeiti', 'Menlo', 'Monaco',
  'Helvetica Neue', 'Avenir Next', 'Optima', 'Hoefler Text', 'SF Mono',
  // 跨平台开源与常见中文字体
  'Noto Sans SC', 'Noto Serif SC', 'Noto Sans Mono CJK SC', 'Source Han Sans SC', 'Source Han Serif SC',
  'LXGW WenKai', 'LXGW WenKai Mono GB', 'Sarasa Gothic SC', 'HarmonyOS Sans SC', 'MiSans',
  'OPPO Sans', 'Alibaba PuHuiTi', 'Fira Code', 'JetBrains Mono', 'Source Code Pro', 'Roboto',
  'Open Sans', 'Lato', 'Inter', 'Oswald', 'Merriweather', 'Noto Sans', 'Noto Serif', 'Ubuntu'
];

let systemFontsPromise: Promise<string[]> | null = null;

/**
 * 函数职责：为选择器提供可点选的字体族名列表。
 * 输入说明：桌面调用原生枚举命令；浏览器探测内置清单后过滤已安装项。
 * 输出说明：排序去重的族名；原生枚举失败时抛出可显示错误，本次结果不缓存以便重试。
 */
export function loadSystemFontFamilies(): Promise<string[]> {
  systemFontsPromise ??= isTauri()
    ? invoke<string[]>('list_system_fonts').catch((error) => {
        systemFontsPromise = null;
        throw error;
      })
    : Promise.resolve(CURATED_BROWSER_FONTS.filter((family) => probeFontInstalled(family)));
  return systemFontsPromise;
}
