import { describe, expect, it } from 'vitest';
import { decodeRevision, encodeDocument, mergeContent, revision, validateEnvelope } from './merge';
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
  it('增量编码只传输未知版本，补丁重建与全文结果一致', async () => {
    // 补丁只在序列化后短于全文时启用，测试正文需足够长。
    const root = await revision(content(`甲\n\n${'长'.repeat(100)}\n\n乙\n`), []);
    const child = await revision(content(`甲改\n\n${'长'.repeat(100)}\n\n乙\n`), [root.id]);
    const doc = { id: crypto.randomUUID(), kind: 'project' as const, head: child.id, revisions: { [root.id]: root, [child.id]: child } };
    const full = encodeDocument(doc, new Set());
    expect(Object.keys(full.revisions)).toHaveLength(2);
    const delta = encodeDocument(doc, new Set([root.id]));
    expect(Object.keys(delta.revisions)).toEqual([child.id]);
    const wire = delta.revisions[child.id];
    expect(wire.base).toBe(root.id); expect(wire.text).toBe('');
    expect(JSON.stringify(wire.patches).length).toBeLessThan(child.content.text.length);
    expect(await decodeRevision(wire, () => root)).toEqual(child);
    await expect(validateEnvelope({ protocol: 3, documents: [delta] })).resolves.toBeDefined();
  });
  it('拒绝不兼容协议篡改内容与缺失基线', async () => {
    const root = await revision(content('正文'), []);
    const doc = { id: crypto.randomUUID(), kind: 'project' as const, head: root.id, revisions: { [root.id]: root } };
    const wire = encodeDocument(doc, new Set());
    await expect(validateEnvelope({ protocol: 3, documents: [wire] })).resolves.toBeDefined();
    await expect(validateEnvelope({ protocol: 2, documents: [wire] })).rejects.toThrow('SYNC_PROTOCOL');
    const tampered = { ...wire.revisions[root.id], text: '篡改' };
    await expect(decodeRevision(tampered, () => undefined)).rejects.toThrow('SYNC_INVALID');
    // 补丁引用必须能解码出原版本：缺失基线可恢复，越界补丁按损坏数据处理。
    const base = await revision(content(`首段\n\n${'长'.repeat(100)}\n\n尾段`), []);
    const child = await revision(content(`首段改\n\n${'长'.repeat(100)}\n\n尾段`), [base.id]);
    const orphan = encodeDocument({ ...doc, head: child.id, revisions: { [base.id]: base, [child.id]: child } }, new Set([base.id]));
    expect(orphan.revisions[child.id].base).toBe(base.id);
    await expect(decodeRevision(orphan.revisions[child.id], () => undefined)).rejects.toThrow('SYNC_BASE_MISSING');
    const badPatch = { ...orphan.revisions[child.id], patches: [{ from: 99999, to: 100000, insert: '' }] };
    await expect(decodeRevision(badPatch, () => base)).rejects.toThrow('SYNC_INVALID');
  });
});
