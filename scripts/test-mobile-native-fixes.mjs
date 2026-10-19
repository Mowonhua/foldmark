/** 已连接真机上的输入、撤回和私有文件删除验收；仅创建并删除本脚本的独立项目。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { connectWebview } from './native-cdp.mjs';
const [adb, serial] = process.argv.slice(2); assert(adb && serial);
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8' });
const phone = await connectWebview(9224), desktop = await connectWebview(9223);
const invoke = (page, command, args = {}) => page.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check) { const end = Date.now() + 60000; while (Date.now() < end) { if (await check()) return; await pause(200); } throw Error('等待真机验收状态超时'); }
const click = async name => phone.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')??b.textContent).trim()===${JSON.stringify(name)}); if(!b) throw Error('按钮未找到：'+${JSON.stringify(name)}); b.click(); })()`);
const capture = name => writeFileSync(`test-results/${name}.png`, execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 20_000_000 }));
try {
  assert.equal(await invoke(desktop, 'plugin:app|identifier'), 'app.taskrail.syncvalidation');
  assert.equal(await invoke(phone, 'plugin:app|identifier'), 'app.taskrail.mobile');
  await phone.evaluate(`document.querySelector('button[aria-label="关闭同步面板"]')?.click()`);
  await click('更多操作'); await pause(50); await click('新增项目');
  await wait(() => phone.evaluate(`!!document.querySelector('.modal input')`));
  const name = `修复验收-${Date.now()}`;
  await phone.evaluate(`(() => { const input=document.querySelector('.modal input'); input.value=${JSON.stringify(name)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click('创建项目');
  await wait(async () => (await invoke(phone, 'load_config')).projects.some(project => project.name === name));
  const project = (await invoke(phone, 'load_config')).projects.find(project => project.name === name);
  assert(project.path.includes('/documents/'));
  const source = '# 留白验收\n\n- [ ] 待办\n\n# 归档\n\n- [x] 完成\n';
  await phone.evaluate(`(() => { const v=document.querySelector('.cm-content').cmTile.view; v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(source)}},selection:{anchor:0}}); v.contentDOM.blur(); })()`);
  await pause(900);
  run('shell', 'rm', '-f', '/sdcard/taskrail-test-ui.xml');
  try { run('shell', 'uiautomator', 'dump', '/sdcard/taskrail-test-ui.xml'); }
  catch (error) {
    // 部分真机会在成功写入后终止 UIAutomator；只接受明确完成的输出，随后仍核对实际 WebView。
    if (!String(error.stdout).includes('UI hierchary dumped to: /sdcard/taskrail-test-ui.xml')) throw error;
  }
  const xml = run('shell', 'cat', '/sdcard/taskrail-test-ui.xml');
  const bounds = /class="android.webkit.WebView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
  assert(bounds, '无法确认 WebView 的屏幕偏移');
  const point = await phone.evaluate(`(() => { const r=document.querySelector('.cm-scroller').getBoundingClientRect();return {x:(r.left+r.width/2)*devicePixelRatio,y:(r.bottom-70)*devicePixelRatio}; })()`);
  run('shell', 'input', 'tap', String(Math.round(point.x + Number(bounds[1]))), String(Math.round(point.y + Number(bounds[2]))));
  run('shell', 'input', 'text', 'BOTTOM_NATIVE');
  await wait(async () => (await invoke(phone, 'read_file', { path: project.path })).text.includes('BOTTOM_NATIVE'));
  const edited = (await invoke(phone, 'read_file', { path: project.path })).text;
  assert(edited.includes('待办\n\nBOTTOM_NATIVE')); assert(edited.endsWith('# 归档\n\n- [x] 完成\n'));
  capture('android-blank-fixed');
  // 通过真实复选框及其保存入口发送选择变化，不能直接改同步存储来伪造撤回。
  await phone.evaluate(`document.querySelector('.sync-status').click()`);
  await wait(() => phone.evaluate(`!!document.querySelector('.sync-document-row')`));
  const toggle = () => phone.evaluate(`[...document.querySelectorAll('.sync-document-row')].find(r=>r.querySelector('.sync-document-name').textContent===${JSON.stringify(name)}).querySelector('input').click()`);
  await toggle();
  let id;
  await wait(async () => { const state = await invoke(phone, 'sync_load_state'); id = Object.values(state.records).find(record => record.binding?.localId === project.id)?.document.id; return !!id; });
  await wait(async () => !!(await invoke(desktop, 'sync_load_state')).records[id]);
  assert(!(await invoke(desktop, 'sync_load_state')).records[id].binding);
  await toggle();
  await wait(async () => !(await invoke(desktop, 'sync_load_state')).records[id]);
  assert((await invoke(phone, 'read_file', { path: project.path })).text.includes('BOTTOM_NATIVE'));
  await click('关闭同步面板'); await click('更多操作'); await pause(50); await click('删除项目');
  await wait(() => phone.evaluate(`!!document.querySelector('.modal')`));
  assert((await phone.evaluate(`document.querySelector('.modal').textContent`)).includes('将删除手机上的文档和恢复草稿'));
  await click('删除项目');
  await wait(async () => !(await invoke(phone, 'load_config')).projects.some(value => value.id === project.id));
  const missing = await phone.evaluate(`window.__TAURI_INTERNALS__.invoke('read_file',{path:${JSON.stringify(project.path)}}).then(()=>false,error=>error.code==='FILE_NOT_FOUND')`);
  assert(missing, '手机删除后私有 Markdown 文件必须不存在');
  assert.equal(await invoke(phone, 'load_recovery', { path: project.path }), null);
  console.log('真机修复验收通过：底部留白输入可见、归档保持不变、取消选择撤回电脑待接收、手机私有正文与草稿实际删除。');
} finally { phone.close(); desktop.close(); }
