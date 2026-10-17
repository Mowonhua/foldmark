import { describe, expect, it } from 'vitest';
import { mergeContent, revision, validateEnvelope } from './merge';
const content = (text: string, name = '项目', archived = false) => ({ text, name, archived });
describe('同步三方合并', () => {
  it('合并不相交段落及项目资料且结果对称', () => {
    const base = content('甲\n\n乙\n\n丙\n');
    const a = content('甲改\n\n乙\n\n丙\n', '新名称');
    const b = content('甲\n\n乙\n\n丙改\n', '项目', true);
    expect(mergeContent(base, a, b)).toEqual(content('甲改\n\n乙\n\n丙改\n', '新名称', true));
    expect(mergeContent(base, a, b)).toEqual(mergeContent(base, b, a));
  });
  it('重叠修改保留冲突且不插入冲突标记', () => {
    expect(mergeContent(content('原文'), content('电脑'), content('手机'))).toBeNull();
  });
  it('任务归档排序删除与并行说明修改均保留冲突', () => {
    const base = content('- [ ] 任务\n\n  说明\n\n- [ ] 其他\n');
    const phone = content(base.text.replace('说明', '新的说明'));
    for (const text of ['- [ ] 其他\n\n# 归档\n\n- [x] 任务\n\n  说明\n', '- [ ] 其他\n\n- [ ] 任务\n\n  说明\n', '- [ ] 其他\n']) {
      expect(mergeContent(base, content(text), phone)).toBeNull();
    }
  });
  it('单端结构变化直接接收且相同修改幂等', () => {
    const base = content('- [ ] 任务\n'); const changed = content('# 归档\n- [x] 任务\n');
    expect(mergeContent(base, base, changed)).toEqual(changed);
    expect(mergeContent(base, changed, changed)).toEqual(changed);
  });
  it('版本内容寻址不受父版本排列和设备时间影响', async () => {
    expect(await revision(content('正文'), ['b', 'a'])).toEqual(await revision(content('正文'), ['a', 'b']));
  });
  it('拒绝不兼容协议篡改内容与缺失祖先', async () => {
    const root = await revision(content('正文'), []);
    const doc = { id: crypto.randomUUID(), kind: 'project', head: root.id, revisions: { [root.id]: root } };
    await expect(validateEnvelope({ protocol: 2, documents: [doc] })).resolves.toBeDefined();
    await expect(validateEnvelope({ protocol: 99, documents: [doc] })).rejects.toThrow('SYNC_PROTOCOL');
    await expect(validateEnvelope({ protocol: 2, documents: [{ ...doc, revisions: { [root.id]: { ...root, content: content('篡改') } } }] })).rejects.toThrow();
    const child = await revision(content('新正文'), [root.id]);
    await expect(validateEnvelope({ protocol: 2, documents: [{ ...doc, head: child.id, revisions: { [child.id]: child } }] })).rejects.toThrow();
  });
});
