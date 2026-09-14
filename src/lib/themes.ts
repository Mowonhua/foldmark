/**
 * 文件职责：定义可移植的主题文件与配色解析边界。
 * 定义范围：主题双色模式、内置主题、外部 JSON 校验与根节点应用。
 */

import paperPackage from '../../themes/paper.json';
import monoPackage from '../../themes/mono.json';
import neumorphicPackage from '../../themes/neumorphic.json';
import liquidGlassPackage from '../../themes/liquid-glass.json';
import frostedGlassPackage from '../../themes/frosted-glass.json';
import { applyAppearance, validateAppearance, type ThemeAppearance } from './theme-appearance';

/** 结构职责：区分明暗模式与系统偏好；主题身份独立保存，不随模式变化。 */
export type ThemeMode = 'light' | 'dark' | 'system';
export const paletteKeys = ['canvas', 'sidebar', 'surface', 'ink', 'muted', 'line', 'accent', 'accent-soft', 'hover', 'danger', 'code', 'selection', 'selection-ink'] as const;
/** 结构职责：覆盖应用和编辑器共用的语义颜色；所有值必须是六位十六进制不透明颜色。 */
export type ThemePalette = Record<typeof paletteKeys[number], string>;
/**
 * 结构职责：一套主题同时承载浅色与深色配色。
 * 字段说明：version 是文件格式版本；id 用于持久化选择与重复导入识别。
 * 约束条件：两个模式必须完整；ID 冲突由主题集合边界检查；monochrome 禁止透明混色。
 */
export interface ThemeDefinition {
  version: 1;
  id: string;
  name: string;
  monochrome?: boolean;
  /** 统一控制界面边角；缺省为 rounded，与旧版主题文件兼容，独立于双色模式。 */
  corners?: 'rounded' | 'square';
  /** 可选通用视觉参数；两种模式分别声明，缺省键回退组件默认值，双色模式不应用扩展。 */
  appearance?: { light: ThemeAppearance; dark: ThemeAppearance };
  light: ThemePalette;
  dark: ThemePalette;
}

// 内置包仅在此登记，结构校验与第三方主题相同；首项为首次启动和移除主题后的默认值。
export const builtInThemes: readonly ThemeDefinition[] = [paperPackage, monoPackage, neumorphicPackage, liquidGlassPackage, frostedGlassPackage].map(validateTheme);

/**
 * 函数职责：校验不可信主题对象并返回仅含受支持字段的副本。
 * 输入说明：值来自 JSON 文件或持久化配置。
 * 输出说明：非法输入抛 THEME_INVALID；不执行 CSS、脚本或外部资源。
 * 实现思路：按固定字段、颜色白名单和版本验证；主题 ID 唯一性由导入与配置集合边界保证。
 */
export function validateTheme(value: unknown): ThemeDefinition {
  const fail = (): never => { throw new Error('THEME_INVALID: 主题需包含 version: 1、唯一 id、名称及完整的浅色和深色六位十六进制配色。'); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail();
  const theme = value as Record<string, unknown>;
  if (theme.version !== 1 || typeof theme.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(theme.id)) return fail();
  if (typeof theme.name !== 'string' || !theme.name.trim() || theme.name.length > 80) return fail();
  if (theme.monochrome !== undefined && typeof theme.monochrome !== 'boolean') return fail();
  if (theme.corners !== undefined && theme.corners !== 'rounded' && theme.corners !== 'square') return fail();
  let appearance: ThemeDefinition['appearance'];
  if (theme.appearance !== undefined) {
    if (typeof theme.appearance !== 'object' || theme.appearance === null || Array.isArray(theme.appearance)) return fail();
    const source = theme.appearance as Record<string, unknown>;
    appearance = { light: validateAppearance(source.light), dark: validateAppearance(source.dark) };
  }
  const palettes = {} as Record<'light' | 'dark', ThemePalette>;
  for (const mode of ['light', 'dark'] as const) {
    const source = theme[mode];
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return fail();
    const colors = source as Record<string, unknown>;
    palettes[mode] = {} as ThemePalette;
    for (const key of paletteKeys) {
      if (!Object.hasOwn(colors, key) || typeof colors[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(colors[key])) return fail();
      palettes[mode][key] = colors[key];
    }
  }
  if (theme.monochrome && new Set(Object.values(palettes).flatMap(palette => Object.values(palette).map(color => color.toUpperCase()))).size !== 2) return fail();
  return { version: 1, id: theme.id, name: theme.name.trim(), ...(theme.monochrome === undefined ? {} : { monochrome: theme.monochrome }), ...(theme.corners === undefined ? {} : { corners: theme.corners }), ...(appearance === undefined ? {} : { appearance }), ...palettes };
}
/**
 * 函数职责：读取用户提供的主题 JSON 文本。
 * 输入说明：文本限制为 64 KiB 字符，允许 UTF-8 BOM。
 * 输出说明：返回完整主题或抛 THEME_INVALID，不修改当前配置。
 * 实现思路：限制大小后解析 JSON 并调用统一校验。
 */
export function parseTheme(text: string): ThemeDefinition {
  if (text.length > 65536) throw new Error('THEME_INVALID: 主题文件不能超过 64 KiB。');
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('THEME_INVALID: 主题文件不是有效的 JSON。'); }
  return validateTheme(value);
}
/**
 * 函数职责：将已校验主题的当前模式应用到文档根节点。
 * 输入说明：systemDark 来自系统颜色偏好；主题不完整时由调用方阻止进入此边界。
 * 输出说明：覆盖整套语义变量和原生控件明暗标记，不保留上一套主题的颜色。
 * 实现思路：解析模式并逐一写入白名单变量。
 */
export function applyTheme(root: HTMLElement, theme: ThemeDefinition, mode: ThemeMode, systemDark: boolean): void {
  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  root.dataset.theme = resolved;
  root.dataset.corners = theme.corners ?? 'rounded';
  root.dataset.monochrome = String(theme.monochrome === true);
  // 双色模式使用基础视觉参数，避免扩展中的阴影或实色引入第三种颜色。
  applyAppearance(root, theme.monochrome ? undefined : theme.appearance?.[resolved]);
  root.style.colorScheme = resolved;
  for (const key of paletteKeys) root.style.setProperty(`--${key}`, theme[resolved][key]);
}
