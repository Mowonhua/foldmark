/** 在独立桌面验收实例与已配对手机上，延迟确认并终止发送端，验证重传不丢稿、不重复写入。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { connectWebview } from './native-cdp.mjs';
const [adb, device, documentId, marker] = process.argv.slice(2);
assert(adb && device && documentId && marker, '参数：adb 路径、设备、文档 ID、待输入标记');
const page = await connectWebview(9223);
const invoke = (command, args = {}) => page.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await pause(200); }
  throw new Error('等待验收状态超时');
}
const android = (...args) => execFileSync(adb, ['-s', device, ...args], { encoding: 'utf8', timeout: 15000 });
let phoneStopped = false;
let paused = false; let breakpoint;
page.on('Debugger.paused', () => { paused = true; });
page.on('Debugger.resumed', () => { paused = false; });
try {
  assert.equal(await invoke('plugin:app|identifier'), 'app.foldmark.syncvalidation');
  const before = await invoke('sync_load_state');
  const record = before.records[documentId]; assert(record?.binding?.enabled);
  assert(!record.document.revisions[record.document.head].content.text.includes(marker), '必须使用新的验收标记');
  const config = await invoke('load_config'); const project = config.projects.find(project => project.id === record.binding.localId);
  assert(project.path.replaceAll('\\', '/').includes('/foldmark/test-results/'), '只能验证专用文档');
  // 原生调用入口不可改写。使用仅限验收实例的调试断点停在确认调用前，此时真实控制器已完成可靠保存。
  await page.call('Debugger.enable');
  const fn = await page.call('Runtime.evaluate', { expression: 'window.__TAURI_INTERNALS__.invoke' });
  breakpoint = (await page.call('Debugger.setBreakpointOnFunctionCall', {
    objectId: fn.result.objectId,
    condition: `cmd === 'sync_respond' && payload?.envelope?.documents?.some(doc => doc.id === ${JSON.stringify(documentId)} && doc.revisions[doc.head].content.text.includes(${JSON.stringify(marker)}))`,
  })).breakpointId;
  console.log(`等待手机在已同步文档中输入 ${marker}`);
  await wait(async () => paused, 180000);
  const saved = await readFile(project.path, 'utf8'); assert(saved.includes(marker));
  const savedTime = (await stat(project.path, { bigint: true })).mtimeNs;
  android('shell', 'am', 'force-stop', 'app.foldmark.mobile'); phoneStopped = true;
  await page.call('Debugger.removeBreakpoint', { breakpointId: breakpoint }); breakpoint = undefined;
  await page.call('Debugger.resume');
  android('shell', 'monkey', '-p', 'app.foldmark.mobile', '-c', 'android.intent.category.LAUNCHER', '1'); phoneStopped = false;
  await wait(async () => {
    const next = await invoke('sync_load_state'); const r = next.records[documentId];
    return r.binding.acknowledged === r.document.head && !r.conflict && r.document.revisions[r.document.head].content.text.includes(marker);
  });
  const after = await invoke('sync_load_state'); const final = await invoke('read_file', { path: project.path });
  assert.equal(final.text, saved);
  assert.equal((await stat(project.path, { bigint: true })).mtimeNs, savedTime, '相同版本重传不能重复改写文件');
  assert.equal(Object.keys(after.records).length, Object.keys(before.records).length);
  console.log('真机确认中断验收通过：正文落盘后、确认发出前终止手机，重启重传后内容一致且文件未重复改写。');
} finally {
  if (breakpoint) await page.call('Debugger.removeBreakpoint', { breakpointId: breakpoint }).catch(() => {});
  if (paused) await page.call('Debugger.resume').catch(() => {});
  await page.call('Debugger.disable').catch(() => {});
  if (phoneStopped) android('shell', 'monkey', '-p', 'app.foldmark.mobile', '-c', 'android.intent.category.LAUNCHER', '1');
  page.close();
}
