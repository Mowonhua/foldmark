/** 在独立桌面验收实例上验证真实 TLS、配对确认、文档交换与撤销。 */
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { randomBytes, X509Certificate, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { connectWebview } from './native-cdp.mjs';
const page = await connectWebview(Number(process.env.FOLDMARK_CDP_PORT ?? 9223));
const invoke = (command, args = {}) => page.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
assert.equal(await invoke('plugin:app|identifier'), 'app.foldmark.lanvalidation', '只能使用独立验收数据目录');
const config = await invoke('load_config');
const path = config.projects[0]?.path;
assert(path?.replaceAll('\\', '/').endsWith('/foldmark/test-results/native-lan.md'), '只能写入专用验收文件');
const wait = async expression => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await page.evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error('等待界面状态超时');
};
const click = name => page.evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(name)});if(!button)throw Error('按钮不存在');button.click();})()`);
const initial = await invoke('sync_status'); assert.equal(initial.paired, false, '验收前应解除已有测试配对');
await writeFile(path, '# 同步验收\n\n电脑段落。\n\n手机段落。\n\n- [ ] 两端任务\n\n  任务说明。\n\n- [ ] 其他任务\n');
await wait(`document.querySelector('.cm-content')?.textContent.includes('电脑段落。')`);
if (!await page.evaluate(`!!document.querySelector('.sync-panel')`)) { await page.evaluate(`document.querySelector('button[aria-label="更多操作"]').click()`); await click('设备同步'); }
const offer = await invoke('sync_offer');
const id = randomBytes(32).toString('hex'), secret = randomBytes(32).toString('hex');
function exchange(payload) {
  return new Promise((resolve, reject) => {
    const [host, port] = offer.address.split(':'); let buffer = Buffer.alloc(0);
    const socket = tls.connect({ host, port: Number(port), servername: 'foldmark.local', ca: new X509Certificate(Buffer.from(offer.certificate)).toString() }, () => {
      const bytes = Buffer.from(JSON.stringify({ protocol: 1, id, secret, ...payload })); const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length); socket.write(Buffer.concat([header, bytes]));
    });
    socket.setTimeout(35000, () => socket.destroy(new Error('同步响应超时')));
    socket.on('error', reject); socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return;
      const result = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString()); socket.end();
      if (result.error) reject(new Error(result.error)); else resolve(result.ok);
    });
  });
}
try {
  await assert.rejects(exchange({ action: 'exchange', envelope: { protocol: 3, selection: { revision: 0, ids: [] }, documents: [] } }), /SYNC_AUTH/);
  assert.equal(await exchange({ action: 'pair', token: offer.token }), false);
  await wait(`!![...document.querySelectorAll('button')].find(button=>button.textContent==='允许连接')`);
  await click('允许连接');
  await wait(`!!document.querySelector('.sync-documents')`);
  assert.equal(await exchange({ action: 'pair', token: offer.token }), true);
  await page.evaluate(`document.querySelector('.sync-documents input').click()`);
  await wait(`(async()=>{const state=await window.__TAURI_INTERNALS__.invoke('sync_load_state');return state&&Object.values(state.records).some(record=>record.binding?.enabled&&record.document.kind==='project');})()`);
  const response = await exchange({ action: 'exchange', envelope: { protocol: 3, selection: { revision: 0, ids: [] }, documents: [] } });
  assert.equal(response.protocol, 3); assert.equal(response.documents.length, 1);
  const document = response.documents[0]; assert(document.revisions[document.head].text.includes('电脑段落'));
  assert(!JSON.stringify(response).includes('D:/Workspace'), '网络消息不能泄露设备路径');
  await exchange({ action: 'exchange', envelope: response });
  await wait(`document.querySelector('.sync-device [role=status]')?.textContent==='已同步'`);
  // 线上版本与电脑持久化格式不同：正文直接为 text 字段，内容哈希键序固定为 text、name、archived。
  const changed = (document, text) => {
    const parents = [document.head]; const base = document.revisions[document.head];
    const content = { text, name: base.name, archived: base.archived };
    const id = createHash('sha256').update(JSON.stringify([parents, content])).digest('hex');
    return { ...document, head: id, revisions: { ...document.revisions, [id]: { id, parents, name: content.name, archived: content.archived, text } } };
  };
  const fromPhone = changed(document, document.revisions[document.head].text.replace('手机段落。', '手机段落已更新。'));
  let latest = await exchange({ action: 'exchange', envelope: { protocol: 3, selection: { revision: 1, ids: [fromPhone.id] }, documents: [fromPhone] } });
  assert((await invoke('read_file', { path })).text.includes('手机段落已更新。'));
  await exchange({ action: 'exchange', envelope: latest });
  // 双方确认后电脑回复只携带 head，不再重复正文；后续并发以手机已确认版本为基线。
  const baseText = fromPhone.revisions[fromPhone.head].text;
  await writeFile(path, baseText.replace('电脑段落。', '电脑段落被外部编辑。'));
  const concurrent = changed(fromPhone, baseText.replace('电脑段落。', '电脑段落被手机修改。'));
  await exchange({ action: 'exchange', envelope: { protocol: 3, selection: { revision: 1, ids: [concurrent.id] }, documents: [concurrent] } });
  await wait(`!![...document.querySelectorAll('button')].find(button=>button.textContent.trim().startsWith('比较并处理'))`);
  assert((await invoke('read_file', { path })).text.includes('电脑段落被外部编辑。'), '外部改动不能被远端静默覆盖');
  await page.evaluate(`([...document.querySelectorAll('button')].find(button=>button.textContent.trim().startsWith('比较并处理'))).click()`);
  await click('选用对端');
  await wait(`(async()=>{const result=await window.__TAURI_INTERNALS__.invoke('read_file',{path:${JSON.stringify(path)}});return result.text.includes('电脑段落被手机修改。')})()`);
  latest = await exchange({ action: 'exchange', envelope: { protocol: 3, selection: { revision: 1, ids: [concurrent.id] }, documents: [concurrent] } });
  await exchange({ action: 'exchange', envelope: latest });
  assert(!(await invoke('read_file', { path })).text.includes('<<<<<<<'));
  await assert.rejects(exchange({ protocol: 2, action: 'ping' }), /SYNC_PROTOCOL/);
  await page.evaluate(`document.querySelector('.sync-connection-settings').open=true`); await click('解除配对');
  await wait(`!![...document.querySelectorAll('button')].find(button=>button.textContent==='显示配对二维码')`);
  await assert.rejects(exchange({ action: 'exchange', envelope: response }), /SYNC_AUTH/);
  console.log('原生局域网验收通过：TLS、电脑确认、正文写入、外部并发冲突、人工合并、重复确认、路径隔离、协议拒绝及配对撤销。');
} finally { page.close(); }
