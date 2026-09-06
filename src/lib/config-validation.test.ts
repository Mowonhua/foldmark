/** 文件职责：验证损坏配置不会进入应用状态或形成同文件双会话。 */
import { describe, expect, it } from 'vitest';
import { validateAppConfig } from './config-validation';
describe('配置边界', () => {
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
});
