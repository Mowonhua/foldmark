/** 文件职责：验证外部主题边界、模式应用和双色约束。 */
import { describe, expect, it } from 'vitest';
import { applyTheme, builtInThemes, paletteKeys, parseTheme, validateTheme } from './themes';
import { validateAppConfig } from './config-validation';

const palette = (color: string) => Object.fromEntries(paletteKeys.map(key => [key, color]));
const custom = () => ({ version: 1, id: 'custom-test', name: '自制主题', light: palette('#F8FAFC'), dark: palette('#0A0A0A') });
describe('主题文件', () => {
  it('内置纯粹主题只包含指定两色，浅深背景对应正确', () => {
    const mono = builtInThemes.find(theme => theme.id === 'mono')!;
    expect(new Set([...Object.values(mono.light), ...Object.values(mono.dark)])).toEqual(new Set(['#0A0A0A', '#F8FAFC']));
    expect(mono.light.canvas).toBe('#F8FAFC'); expect(mono.dark.canvas).toBe('#0A0A0A');
  });
  it('兼容旧明暗偏好，拒绝悬空主题选择与重复持久化 ID', () => {
    expect(validateAppConfig({ projects: [], preferences: { theme: 'dark' } })).not.toBeNull();
    expect(validateAppConfig({ projects: [], preferences: { themeId: 'custom-test' }, customThemes: [custom()] })).not.toBeNull();
    for (const config of [
      { projects: [], preferences: { themeId: 'missing' } },
      { projects: [], preferences: { theme: ['system'] } },
      { projects: [], customThemes: [custom(), custom()] },
      { projects: [], customThemes: [{ ...custom(), dark: {} }] },
    ]) expect(() => validateAppConfig(config)).toThrow('STATE_CONFIG_INVALID');
  });
  it('解析完整的双模式文件并移除未知字段', () => {
    expect(parseTheme('\uFEFF' + JSON.stringify({ ...custom(), extra: true }))).toEqual(custom());
  });
  it('拒绝损坏、不完整、保留 ID 和可执行样式值', () => {
    for (const value of [null, {}, { ...custom(), version: 2 }, { ...custom(), id: 'paper' }, { ...custom(), dark: {} }, { ...custom(), light: { ...palette('#ffffff'), ink: 'url(https://example.com)' } }]) {
      expect(() => validateTheme(value)).toThrow('THEME_INVALID');
    }
    expect(() => parseTheme('{')).toThrow('THEME_INVALID');
    expect(() => parseTheme(' '.repeat(65537))).toThrow('THEME_INVALID');
  });
  it('双色声明拒绝第三种颜色', () => {
    expect(validateTheme({ ...custom(), monochrome: true }).monochrome).toBe(true);
    expect(() => validateTheme({ ...custom(), monochrome: true, light: { ...palette('#F8FAFC'), ink: '#123456' } })).toThrow('THEME_INVALID');
  });
  it('根据模式覆盖全部变量并更新原生控件明暗', () => {
    const root = document.createElement('div');
    const theme = validateTheme(custom());
    applyTheme(root, theme, 'system', true);
    expect(root.style.getPropertyValue('--canvas')).toBe('#0A0A0A');
    expect(root.style.colorScheme).toBe('dark');
    applyTheme(root, theme, 'light', true);
    for (const key of paletteKeys) expect(root.style.getPropertyValue(`--${key}`)).toBe('#F8FAFC');
    expect(root.style.colorScheme).toBe('light');
  });
});
