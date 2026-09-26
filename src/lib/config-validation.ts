/**
 * 文件职责：在应用状态赋值前校验持久化配置形状。
 * 定义范围：配置边界验证；不写入磁盘，不以默认配置覆盖无法读取的原数据。
 */
import type { AppConfig } from './contracts';
import { builtInThemes, validateTheme } from './themes';

/**
 * 函数职责：拒绝会使界面崩溃或同文件形成双会话的配置。
 * 输入说明：值来自不可信的持久化边界；null 表示首次使用。
 * 输出说明：合法配置原样返回；非法配置抛 STATE_CONFIG_INVALID，原文件保持不动。
 * 实现思路：验证项目关联和界面状态的必要字段，偏好缺失字段由应用默认值补齐。
 */
export function validateAppConfig(value: unknown): AppConfig | null {
  if (value === null) return null;
  const fail = (): never => { throw new Error('STATE_CONFIG_INVALID: 项目配置格式无效，原配置已保留，请修复配置后重新打开应用。'); };
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
    for (const flag of [p.autoCheckUpdates, p.autoDownloadUpdates]) if (flag !== undefined && typeof flag !== 'boolean') return fail();
    if (p.theme !== undefined && (typeof p.theme !== 'string' || !['light', 'dark', 'system'].includes(p.theme))) return fail();
    if (p.themeId !== undefined && (typeof p.themeId !== 'string' || !themeIds.has(p.themeId))) return fail();
    if (p.fontFamily !== undefined && typeof p.fontFamily !== 'string') return fail();
    for (const number of [p.fontSize, p.contentWidth]) if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number <= 0)) return fail();
  }
  if (value.projectViews !== undefined) {
    if (!record(value.projectViews)) return fail();
    for (const view of Object.values(value.projectViews)) {
      if (!record(view) || !['todo', 'archive', 'source'].includes(String(view.mode))) return fail();
      if (typeof view.cursor !== 'number' || !Number.isSafeInteger(view.cursor) || view.cursor < 0) return fail();
      if (typeof view.scrollTop !== 'number' || !Number.isFinite(view.scrollTop) || view.scrollTop < 0) return fail();
      if (!Array.isArray(view.folded) || view.folded.some(key => typeof key !== 'string')) return fail();
      if (view.sourceView !== undefined && view.sourceView !== 'todo' && view.sourceView !== 'archive') return fail();
      if (view.sourceReturn !== undefined) {
        if (!record(view.sourceReturn)) return fail();
        for (const key of ['cursor', 'scrollTop', 'anchor', 'offset']) {
          const coordinate = view.sourceReturn[key];
          if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || (key !== 'offset' && coordinate < 0)) return fail();
        }
      }
    }
  }
  return value as unknown as AppConfig;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
