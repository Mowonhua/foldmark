/**
 * 文件职责：在应用状态赋值前校验持久化配置形状。
 * 定义范围：配置边界验证；不写入磁盘，不以默认配置覆盖无法读取的原数据。
 */
import type { AppConfig } from './contracts';
import { builtInThemes, validateTheme } from './themes';
import { translate } from './i18n';

/**
 * 函数职责：拒绝会使界面崩溃或同文件形成双会话的配置。
 * 输入说明：值来自不可信的持久化边界；null 表示首次使用。
 * 输出说明：合法配置原样返回；非法配置抛 STATE_CONFIG_INVALID，原文件保持不动。
 * 实现思路：验证项目关联和界面状态的必要字段，偏好缺失字段由应用默认值补齐。
 */
export function validateAppConfig(value: unknown): AppConfig | null {
  if (value === null) return null;
  const fail = (): never => { throw new Error(`STATE_CONFIG_INVALID: ${translate('项目配置格式无效，原配置已保留，请修复配置后重新打开应用。')}`); };
  if (!record(value) || !Array.isArray(value.projects)) return fail();
  const identities = new Set<string>(); const paths = new Set<string>();
  for (const project of value.projects) {
    if (!record(project) || !nonempty(project.id) || !nonempty(project.name) || !nonempty(project.path)) return fail();
    if (project.archived !== undefined && typeof project.archived !== 'boolean') return fail();
    const path = project.path.replace(/\\/g, '/').toLocaleLowerCase();
    if (identities.has(project.id) || paths.has(path)) return fail();
    identities.add(project.id); paths.add(path);
  }
  if (value.activeProjectId !== null && value.activeProjectId !== undefined && typeof value.activeProjectId !== 'string') return fail();
  const themeIds = new Set(builtInThemes.map(theme => theme.id));
  if (value.customThemes !== undefined) {
    if (!Array.isArray(value.customThemes)) return fail();
    for (const source of value.customThemes) {
      try {
        const theme = validateTheme(source);
        if (themeIds.has(theme.id)) return fail();
        themeIds.add(theme.id);
      } catch { return fail(); }
    }
  }
  if (value.preferences !== undefined) {
    if (!record(value.preferences)) return fail();
    const p = value.preferences;
    // 旧配置允许缺省；未知语言标识由翻译层回退，便于跨版本共享配置。
    if (p.locale !== undefined && typeof p.locale !== 'string') return fail();
    for (const flag of [p.autoCheckUpdates, p.autoDownloadUpdates, p.keepTransparentOnBlur, p.sidebarOpen, p.headingAdd]) if (flag !== undefined && typeof flag !== 'boolean') return fail();
    if (p.sidebarView !== undefined && p.sidebarView !== 'nav' && p.sidebarView !== 'outline') return fail();
    if (p.theme !== undefined && (typeof p.theme !== 'string' || !['light', 'dark', 'system'].includes(p.theme))) return fail();
    if (p.themeId !== undefined && (typeof p.themeId !== 'string' || !themeIds.has(p.themeId))) return fail();
    if (p.fontFamily !== undefined && typeof p.fontFamily !== 'string') return fail();
    for (const number of [p.fontSize, p.contentWidth]) if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number <= 0)) return fail();
  }
  if (value.projectViews !== undefined) {
    if (!record(value.projectViews)) return fail();
    for (const view of Object.values(value.projectViews)) if (!validView(view)) return fail();
  }
  if (value.inspiration !== undefined) {
    if (!record(value.inspiration) || !nonempty(value.inspiration.path)) return fail();
    if (value.inspiration.active !== undefined && typeof value.inspiration.active !== 'boolean') return fail();
    if (value.inspiration.view !== undefined && !validView(value.inspiration.view)) return fail();
  }
  return value as unknown as AppConfig;
}
/**
 * 函数职责：验证项目与灵感簿共用的阅读状态形状，保证恢复逻辑不会遇到非法坐标。
 * 输入说明：值来自不可信的持久化边界；字段允许旧配置缺省。
 * 输出说明：形状合法返回 true；调用方负责整体配置的失败处理。
 */
function validView(view: unknown): boolean {
  if (!record(view) || !['todo', 'archive', 'source'].includes(String(view.mode))) return false;
  if (typeof view.cursor !== 'number' || !Number.isSafeInteger(view.cursor) || view.cursor < 0) return false;
  if (typeof view.scrollTop !== 'number' || !Number.isFinite(view.scrollTop) || view.scrollTop < 0) return false;
  if (!Array.isArray(view.folded) || view.folded.some(key => typeof key !== 'string')) return false;
  if (view.expandedCompletedGroups !== undefined && (!Array.isArray(view.expandedCompletedGroups) || view.expandedCompletedGroups.some(key => typeof key !== 'string'))) return false;
  if (view.sourceView !== undefined && view.sourceView !== 'todo' && view.sourceView !== 'archive') return false;
  if (view.sourceReturn !== undefined) {
    if (!record(view.sourceReturn)) return false;
    for (const key of ['cursor', 'scrollTop', 'anchor', 'offset']) {
      const coordinate = view.sourceReturn[key];
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || (key !== 'offset' && coordinate < 0)) return false;
    }
  }
  return true;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
