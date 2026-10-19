import { describe, expect, it } from 'vitest';
import { assembleMerge, decodeRevision, defaultChoices, diffHunks, encodeDocument, mergeContent, revision, validateEnvelope } from './merge';
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
  it('两端各自新增与任务归档移动都保留', () => {
    const base = content('# 本周\n\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n');
    const desktop = content('# 本周\n\n- [ ] 丙\n- [ ] 丁\n\n# 归档\n\n- [x] 甲\n- [x] 乙\n');
    const added = ['戊一', '戊二', '戊三', '戊四', '戊五', '戊六'].map(title => `- [ ] ${title}\n`).join('');
    const phone = content(base.text + added);
    // 归档移动不是文本冲突：两端新增都保留，新增章节排在新增任务之后。
    const merged = content('# 本周\n\n- [ ] 丙\n' + added + '- [ ] 丁\n\n# 归档\n\n- [x] 甲\n- [x] 乙\n');
    expect(mergeContent(base, desktop, phone)).toEqual(merged);
    expect(mergeContent(base, phone, desktop)).toEqual(merged);
  });
  it('排序移动与并行说明修改合并，搬运覆盖另一端改动时保留冲突', () => {
    const base = content('- [ ] 任务\n\n  说明\n\n- [ ] 其他\n');
    const phone = content(base.text.replace('说明', '新的说明'));
    // 只把任务移到前面：两端改动的字符区间不重叠，双方改动都保留。
    expect(mergeContent(base, content('- [ ] 其他\n\n- [ ] 任务\n\n  说明\n'), phone))
      .toEqual(content('- [ ] 其他\n\n- [ ] 任务\n\n  新的说明\n'));
    // 归档把说明搬进新章节：搬运覆盖了另一端改动的字符，无法区分移动与无关增删，仍要求选择。
    expect(mergeContent(base, content('- [ ] 其他\n\n# 归档\n\n- [x] 任务\n\n  说明\n'), phone)).toBeNull();
  });
  it('删除与并行修改落在同一段内容时保留冲突', () => {
    const base = content('- [ ] 任务\n\n  说明\n\n- [ ] 其他\n');
    const phone = content(base.text.replace('说明', '新的说明'));
    expect(mergeContent(base, content('- [ ] 其他\n'), phone)).toBeNull();
  });
  it('同一位置的两端新增都保留且与调用顺序无关', () => {
    const base = content('甲\n');
    const merged = content('甲\n丙\n乙\n');
    expect(mergeContent(base, content('甲\n乙\n'), content('甲\n丙\n'))).toEqual(merged);
    expect(mergeContent(base, content('甲\n丙\n'), content('甲\n乙\n'))).toEqual(merged);
  });
  it('差异块按类型给出默认选择并支持逐块改用另一端', () => {
    const base = '- [ ] 甲\n- [ ] 乙\n';
    const desktop = '- [ ] 甲改\n- [ ] 乙\n';
    const phone = '- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n';
    const hunks = diffHunks(base, desktop, phone);
    expect(hunks.map(hunk => [hunk.kind, hunk.local, hunk.remote])).toEqual([['local', '- [ ] 甲改\n', '- [ ] 甲\n'], ['remote', '', '- [ ] 丙\n']]);
    expect(defaultChoices(hunks)).toEqual(['local', 'remote']);
    // 逐块改用另一端就是逐块放弃对应改动，未改动的一侧取祖先原文。
    expect(assembleMerge(base, hunks, ['remote', 'local'])).toBe(base);
    expect(() => assembleMerge(base, hunks, ['union', 'remote'])).toThrow('SYNC_INVALID');
    expect(mergeContent(content(base), content(desktop), content(phone))).toEqual(content('- [ ] 甲改\n- [ ] 乙\n- [ ] 丙\n'));
  });
  it('两端改动结果相同时差异块直接采纳', () => {
    const base = '# 工作清单\n\n提交发布说明。\n';
    const changed = '# 工作清单\n\n提交发布说明，附上更新日志。\n';
    // 两端改了同一段内容但结果一致：不需要用户选择，任一端文本都能收敛到同一正文。
    const hunks = diffHunks(base, changed, changed);
    expect(hunks.map(hunk => hunk.kind)).toEqual(['same']);
    expect(defaultChoices(hunks)).toEqual(['local']);
    expect(assembleMerge(base, hunks, defaultChoices(hunks))).toBe(changed);
    expect(mergeContent(content(base), content(changed), content(changed))).toEqual(content(changed));
  });
  it('两端改动同一段已有内容时差异块必须选择', () => {
    const base = '整理本周的设计反馈。\n';
    const hunks = diffHunks(base, '本机整理后的设计反馈。\n', '手机整理后的设计反馈。\n');
    expect(hunks.map(hunk => hunk.kind)).toEqual(['overlap']);
    expect(defaultChoices(hunks)).toEqual([null]);
    expect(assembleMerge(base, hunks, ['local'])).toBe('本机整理后的设计反馈。\n');
    expect(mergeContent(content(base), content('本机整理后的设计反馈。\n'), content('手机整理后的设计反馈。\n'))).toBeNull();
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
