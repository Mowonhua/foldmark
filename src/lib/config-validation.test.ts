/** 文件职责：验证损坏配置不会进入应用状态或形成同文件双会话。 */
import { describe, expect, it } from 'vitest';
import { validateAppConfig } from './config-validation';
describe('配置边界', () => {
  it('语言偏好兼容旧配置和未来语言，拒绝错误字段形状', () => {
    for (const locale of [undefined, 'zh-CN', 'en', 'system', 'fr']) {
      const config = { projects: [], preferences: { locale } };
      expect(validateAppConfig(config)).toBe(config);
    }
    for (const locale of [null, 42, true, [], {}]) {
      expect(() => validateAppConfig({ projects: [], preferences: { locale } })).toThrow('STATE_CONFIG_INVALID');
    }
  });
  it('项目归档允许旧配置缺省和布尔值，拒绝其他类型', () => {
    const project = { id: 'one', name: '项目', path: 'D:/清单.md' };
    for (const candidate of [project, { ...project, archived: false }, { ...project, archived: true }]) {
      const config = { projects: [candidate] };
      expect(validateAppConfig(config)).toBe(config);
    }
    for (const archived of ['false', 0, null, [], {}]) {
      expect(() => validateAppConfig({ projects: [{ ...project, archived }] })).toThrow('STATE_CONFIG_INVALID');
    }
  });
  it('更新偏好允许旧配置缺省并拒绝字符串布尔值', () => {
    const config = { projects: [], preferences: { autoCheckUpdates: false, autoDownloadUpdates: true } };
    expect(validateAppConfig(config)).toBe(config);
    for (const key of ['autoCheckUpdates', 'autoDownloadUpdates']) {
      expect(() => validateAppConfig({ projects: [], preferences: { [key]: 'false' } })).toThrow('STATE_CONFIG_INVALID');
    }
  });
  it('允许首次启动和保留未知附加字段的有效关联', () => {
    expect(validateAppConfig(null)).toBe(null);
    const valid = { projects: [{ id: 'one', name: '项目', path: 'D:/清单.md' }], activeProjectId: 'one', future: true };
    expect(validateAppConfig(valid)).toBe(valid);
  });
  it('拒绝破坏渲染形状或出现重复路径的内容', () => {
    for (const invalid of [[], {}, { projects: 'broken' }, { projects: [{ id: 'one', name: 1, path: 'a' }] }, { projects: [], projectViews: { one: { mode: 'todo', cursor: 'zero' } } }]) {
      expect(() => validateAppConfig(invalid)).toThrow('STATE_CONFIG_INVALID');
    }
    expect(() => validateAppConfig({ projects: [{ id: 'a', name: '甲', path: 'D:\\List.md' }, { id: 'b', name: '乙', path: 'd:/list.md' }] })).toThrow('STATE_CONFIG_INVALID');
  });
  it('拒绝非数值的字号而不偷偷覆盖原配置', () => {
    const config = { projects: [], preferences: { fontSize: 'large' } };
    expect(() => validateAppConfig(config)).toThrow('STATE_CONFIG_INVALID'); expect(config.preferences.fontSize).toBe('large');
  });
  it('接受旧源码状态及带来源和阅读位置的新源码状态', () => {
    const oldView = { mode: 'source', cursor: 0, scrollTop: 0, folded: [] };
    for (const view of [oldView, { ...oldView, sourceView: 'archive', sourceReturn: { cursor: 8, scrollTop: 120.5, anchor: 4, offset: -8.5 } }]) {
      const config = { projects: [], projectViews: { one: view } };
      expect(validateAppConfig(config)).toBe(config);
    }
  });
  it('拒绝无效源码来源和无法安全恢复的阅读坐标', () => {
    const view = { mode: 'source', cursor: 0, scrollTop: 0, folded: [] };
    const sourceReturn = { cursor: 0, scrollTop: 0, anchor: 0, offset: 0 };
    const invalid = [
      { ...view, sourceView: 'source' }, { ...view, sourceView: null },
      ...[null, {}, { ...sourceReturn, cursor: -1 }, { ...sourceReturn, anchor: NaN }, { ...sourceReturn, scrollTop: Infinity }, { ...sourceReturn, offset: Infinity }, { ...sourceReturn, offset: '0' }].map(value => ({ ...view, sourceReturn: value })),
    ];
    for (const candidate of invalid) expect(() => validateAppConfig({ projects: [], projectViews: { one: candidate } })).toThrow('STATE_CONFIG_INVALID');
  });
});
