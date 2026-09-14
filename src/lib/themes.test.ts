/** 文件职责：验证外部主题边界、模式应用和双色约束。 */
import { describe, expect, it } from 'vitest';
import { applyTheme, builtInThemes, paletteKeys, parseTheme, validateTheme } from './themes';
import { validateAppConfig } from './config-validation';
import { appearanceProperties } from './theme-appearance';

const palette = (color: string) => Object.fromEntries(paletteKeys.map(key => [key, color]));
const custom = () => ({ version: 1, id: 'custom-test', name: '自制主题', light: palette('#F8FAFC'), dark: palette('#0A0A0A') });
describe('主题文件', () => {
  it('滚动条参数可导入导出和恢复配置，明暗、旧主题及双色切换均清理缺省状态', () => {
    const appearance = {
      light: { 'scrollbar-track': 'transparent', 'scrollbar-thumb': '#52657880', 'scrollbar-thumb-hover': '#526578', 'scrollbar-thumb-active': '#365d91', 'scrollbar-radius': 6, 'scrollbar-thumb-shadow': 'inset 1px 1px 1px #ffffff80', 'scrollbar-track-shadow': 'none' },
      dark: { 'scrollbar-thumb': '#a5b2c4' },
    };
    const theme = parseTheme(JSON.stringify({ ...custom(), appearance }));
    expect(theme.appearance).toEqual(appearance);
    expect(parseTheme(JSON.stringify(theme))).toEqual(theme);
    const config = validateAppConfig(JSON.parse(JSON.stringify({ projects: [], customThemes: [theme], preferences: { themeId: theme.id } })));
    expect(config?.customThemes?.[0].appearance).toEqual(appearance);
    const root = document.createElement('div');
    applyTheme(root, theme, 'light', false);
    expect(root.style.getPropertyValue('--scrollbar-radius')).toBe('6px');
    expect(root.style.getPropertyValue('--scrollbar-thumb-shadow')).toBe(appearance.light['scrollbar-thumb-shadow']);
    applyTheme(root, theme, 'system', true);
    expect(root.style.getPropertyValue('--scrollbar-thumb')).toBe('#a5b2c4');
    expect(root.style.getPropertyValue('--scrollbar-thumb-hover')).toBe('');
    expect(root.style.getPropertyValue('--scrollbar-radius')).toBe('');
    expect(root.style.getPropertyValue('--scrollbar-thumb-shadow')).toBe('');
    for (const fallback of [validateTheme(custom()), validateTheme({ ...theme, monochrome: true })]) {
      applyTheme(root, theme, 'light', false);
      applyTheme(root, fallback, 'light', false);
      for (const key of Object.keys(appearance.light)) expect(root.style.getPropertyValue(`--${key}`)).toBe('');
    }
  });
  it('滚动条参数拒绝注入表达式与越界尺寸', () => {
    for (const light of [{ 'scrollbar-thumb': 'var(--ink)' }, { 'scrollbar-track': 'url(x)' }, { 'scrollbar-thumb-hover': '#12345' }, { 'scrollbar-thumb-active': null }, { 'scrollbar-radius': -1 }, { 'scrollbar-radius': 33 }, { 'scrollbar-thumb-shadow': '0px 0px -1px #ffffff' }, { 'scrollbar-track-shadow': 'none; color:red' }]) {
      expect(() => validateTheme({ ...custom(), appearance: { light, dark: {} } })).toThrow('THEME_INVALID');
    }
  });
  it('表面光学参数往返保存并清除旧值，禁止表达式和越界滤镜', () => {
    const theme = parseTheme(JSON.stringify({ ...custom(), appearance: {
      light: { 'surface-saturation': 1.6, 'surface-contrast': 1.15, 'surface-brightness': 1.1, 'control-hover-lift': 1, 'surface-sheen-start': '#ffffff38', 'floating-border-left': '#ffffff66', 'floating-radius-top-left': 32 },
      dark: { 'surface-contrast': 1 },
    } }));
    expect(parseTheme(JSON.stringify(theme))).toEqual(theme);
    expect(validateAppConfig({ projects: [], customThemes: [theme], preferences: { themeId: theme.id } })).not.toBeNull();
    const root = document.createElement('div');
    applyTheme(root, theme, 'light', false);
    expect(root.style.getPropertyValue('--surface-saturation')).toBe('1.6');
    expect(root.style.getPropertyValue('--control-hover-lift')).toBe('1px');
    applyTheme(root, theme, 'system', true);
    expect(root.style.getPropertyValue('--surface-saturation')).toBe('');
    expect(root.style.getPropertyValue('--control-hover-lift')).toBe('');
    applyTheme(root, theme, 'light', false);
    applyTheme(root, builtInThemes.find(theme => theme.id === 'mono')!, 'light', false);
    for (const key of Object.keys(appearanceProperties)) expect(root.style.getPropertyValue(`--${key}`)).toBe('');
    for (const light of [{ 'surface-saturation': 2.01 }, { 'surface-brightness': .49 }, { 'surface-contrast': 'contrast(1)' }, { 'control-hover-lift': -1 }, { 'control-hover-lift': 3 }, { 'surface-reflection': 'url(x)' }]) {
      expect(() => validateTheme({ ...custom(), appearance: { light, dark: {} } })).toThrow('THEME_INVALID');
    }
  });
  it('窗口材质保留导入导出参数，拒绝未知材质和非颜色背景', () => {
    const theme = parseTheme(JSON.stringify({ ...custom(), appearance: { light: { 'window-material': 'transparent', 'window-background': '#ffffff70' }, dark: { 'window-material': 'acrylic' } } }));
    expect(theme.appearance?.light['window-material']).toBe('transparent');
    expect(parseTheme(JSON.stringify(theme))).toEqual(theme);
    for (const light of [{ 'window-material': 'mica' }, { 'window-material': null }, { 'window-background': 'linear-gradient(red, blue)' }]) {
      expect(() => validateTheme({ ...custom(), appearance: { light, dark: {} } })).toThrow('THEME_INVALID');
    }
  });
  it('透明表面参数可往返保存、跟随系统并在切换旧主题时清除', () => {
    const theme = parseTheme(JSON.stringify({ ...custom(), appearance: {
      light: { 'sidebar-background': '#ffffff88', 'floating-background': '#ffffffcc', 'sidebar-blur': 12, 'floating-blur': 24, 'floating-shadow': '0px 8px 24px #10203022' },
      dark: { 'floating-background': '#182030dd', 'floating-blur': 32 },
    } }));
    expect(theme.appearance?.light['sidebar-background']).toBe('#ffffff88');
    expect(parseTheme(JSON.stringify(theme))).toEqual(theme);
    expect(validateAppConfig({ projects: [], customThemes: [theme], preferences: { themeId: theme.id } })).not.toBeNull();
    const root = document.createElement('div');
    applyTheme(root, theme, 'light', false);
    expect(root.style.getPropertyValue('--sidebar-blur')).toBe('12px');
    applyTheme(root, theme, 'system', true);
    expect(root.style.getPropertyValue('--floating-blur')).toBe('32px');
    expect(root.style.getPropertyValue('--sidebar-background')).toBe('');
    applyTheme(root, validateTheme(custom()), 'light', false);
    for (const key of Object.keys(appearanceProperties)) expect(root.style.getPropertyValue(`--${key}`)).toBe('');
  });
  it('透明参数仍拒绝非法颜色与模糊表达式，基础配色保持不透明', () => {
    for (const light of [{ 'sidebar-blur': -1 }, { 'floating-blur': 33 }, { 'floating-blur': 'blur(2px)' }, { 'floating-background': '#1234567' }, { 'floating-background': 'url(x)' }]) {
      expect(() => validateTheme({ ...custom(), appearance: { light, dark: {} } })).toThrow('THEME_INVALID');
    }
    expect(() => validateTheme({ ...custom(), light: palette('#ffffff88') })).toThrow('THEME_INVALID');
  });
  it.each([['neumorphic', '新拟物'], ['liquid-glass', '液态玻璃'], ['frosted-glass', '磨砂玻璃']])('%s 支持内置选择、配置恢复和复制导入时保留表面效果', (id, name) => {
    const theme = builtInThemes.find(theme => theme.id === id)!;
    expect(theme?.name).toBe(name);
    expect(theme.appearance?.light).toBeDefined();
    const copy = parseTheme(JSON.stringify({ ...theme, id: 'soft-custom' }));
    expect(copy.appearance).toEqual(theme.appearance);
    expect(validateAppConfig({ projects: [], preferences: { themeId: theme.id } })).not.toBeNull();
    expect(validateAppConfig({ projects: [], preferences: { themeId: copy.id }, customThemes: [copy] })).not.toBeNull();
  });
  it('视觉参数随模式覆盖，缺省、旧主题与双色模式均清除上一次效果', () => {
    const root = document.createElement('div');
    const theme = validateTheme({ ...custom(), appearance: {
      light: { 'control-shadow': '4px 4px 9px #c1c5c9, -4px -4px 9px #f6f8fa', 'control-radius': 9 },
      dark: { 'control-shadow': 'inset 3px 3px 6px #151a20' },
    } });
    applyTheme(root, theme, 'light', false);
    expect(root.style.getPropertyValue('--control-radius')).toBe('9px');
    applyTheme(root, theme, 'system', true);
    expect(root.style.getPropertyValue('--control-shadow')).toBe('inset 3px 3px 6px #151a20');
    expect(root.style.getPropertyValue('--control-radius')).toBe('');
    for (const fallback of [validateTheme(custom()), validateTheme({ ...theme, monochrome: true })]) {
      applyTheme(root, theme, 'light', false);
      applyTheme(root, fallback, 'light', false);
      for (const key of Object.keys(appearanceProperties)) expect(root.style.getPropertyValue(`--${key}`)).toBe('');
    }
  });
  it('视觉参数只接受有限值，拒绝资源地址、表达式、负模糊半径及不完整模式', () => {
    for (const appearance of [null, [], {}, { light: {}, dark: [] }, { light: {}, dark: null }]) {
      expect(() => validateTheme({ ...custom(), appearance })).toThrow('THEME_INVALID');
    }
    for (const light of [
      { 'control-radius': -1 }, { 'control-radius': 33 }, { 'control-radius': '9px' },
      { 'control-radius': Infinity }, { 'tab-active-weight': 901 },
      { 'control-background': 'url(https://example.com)' }, { 'control-background': 'var(--untrusted)' },
      { 'control-shadow': '4px 4px -1px #ffffff' }, { 'control-shadow': '100px 0px 9px #ffffff' },
      { 'control-shadow': '0px 0px 1px #ffffff; color:red' },
      { 'control-shadow': Array(5).fill('0px 0px 1px #ffffff').join(', ') },
      { 'control-shadow': null }, { 'field-border': {} },
      { 'task-checkbox-checked-mark': 'url(https://example.com)' },
      { 'task-checkbox-checked-mark': '"; color:red' },
      { 'task-checkbox-checked-mark': '●●' },
    ]) expect(() => validateTheme({ ...custom(), appearance: { light, dark: {} } })).toThrow('THEME_INVALID');
  });
  it('白名单限制导入及配置应用，不将未知参数注入页面', () => {
    const appearance = { light: { 'control-shadow': 'none', 'field-border': 'transparent', 'control-radius': 0, 'tab-active-weight': 550, 'unknown-color': '#123456' }, dark: {} };
    const theme = validateTheme({ ...custom(), appearance });
    expect(theme.appearance?.light).not.toHaveProperty('unknown-color');
    const root = document.createElement('div');
    // 配置验证不替换原对象，应用边界仍须限制写入字段。
    applyTheme(root, { ...theme, appearance }, 'light', false);
    expect(root.style.getPropertyValue('--unknown-color')).toBe('');
    expect(root.style.getPropertyValue('--control-radius')).toBe('0px');
    expect(root.style.getPropertyValue('--tab-active-weight')).toBe('550');
  });
  it.each(['●', ''])('完成标记 %j 作为 CSS 字符串应用，切换旧主题后恢复默认标记', mark => {
    const root = document.createElement('div');
    const theme = parseTheme(JSON.stringify({ ...custom(), appearance: {
      light: { 'task-checkbox-checked-mark': mark, 'task-checkbox-checked-mark-size': 6, 'task-checkbox-checked-mark-width': 8, 'task-checkbox-checked-mark-height': 8 },
      dark: { 'task-checkbox-checked-mark': '✓' },
    } }));
    applyTheme(root, theme, 'light', false);
    expect(root.style.getPropertyValue('--task-checkbox-checked-mark')).toBe(JSON.stringify(mark));
    expect(root.style.getPropertyValue('--task-checkbox-checked-mark-width')).toBe('8px');
    expect(root.style.getPropertyValue('--task-checkbox-checked-mark-height')).toBe('8px');
    expect(root.style.getPropertyValue('--task-checkbox-checked-mark-size')).toBe('6px');
    applyTheme(root, theme, 'dark', false);
    expect(root.style.getPropertyValue('--task-checkbox-checked-mark')).toBe('"✓"');
    expect(root.style.getPropertyValue('--task-checkbox-checked-mark-size')).toBe('');
    expect(root.style.getPropertyValue('--task-checkbox-checked-mark-width')).toBe('');
    expect(root.style.getPropertyValue('--task-checkbox-checked-mark-height')).toBe('');
    applyTheme(root, validateTheme(custom()), 'light', false);
    expect(root.style.getPropertyValue('--task-checkbox-checked-mark')).toBe('');
  });
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
  it('内置主题包可通过相同的文件解析器，保留边角声明', () => {
    for (const theme of builtInThemes) expect(parseTheme(JSON.stringify(theme))).toEqual(theme);
    expect(builtInThemes.find(theme => theme.id === 'mono')?.corners).toBe('square');
  });
  it('边角独立于双色声明，切换旧主题时恢复默认边角', () => {
    const root = document.createElement('div');
    const square = parseTheme(JSON.stringify({ ...custom(), corners: 'square' }));
    expect(square.corners).toBe('square');
    applyTheme(root, square, 'light', false);
    expect(root.dataset.corners).toBe('square');
    expect(root.dataset.monochrome).toBe('false');
    applyTheme(root, validateTheme({ ...custom(), monochrome: true, corners: 'rounded' }), 'dark', false);
    expect(root.dataset.corners).toBe('rounded');
    applyTheme(root, square, 'dark', false);
    applyTheme(root, validateTheme(custom()), 'light', false);
    expect(root.dataset.corners).toBe('rounded');
    for (const corners of [null, 0, {}, 'url(https://example.com)']) {
      expect(() => validateTheme({ ...custom(), corners })).toThrow('THEME_INVALID');
    }
  });
  it('拒绝损坏、不完整和可执行样式值', () => {
    for (const value of [null, {}, { ...custom(), version: 2 }, { ...custom(), dark: {} }, { ...custom(), light: { ...palette('#ffffff'), ink: 'url(https://example.com)' } }]) {
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
