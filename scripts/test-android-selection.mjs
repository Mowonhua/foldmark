/** 真机长按验收：原生触摸输入应同时产生正文选区和系统复制菜单。 */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { connectWebview } from './native-cdp.mjs';
const serial = process.env.FOLDMARK_ANDROID_DEVICE;
if (!serial) throw new Error('请指定 FOLDMARK_ANDROID_DEVICE');
const adb = `${process.env.ANDROID_HOME}/platform-tools/adb.exe`;
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8' });
const page = await connectWebview(Number(process.env.FOLDMARK_CDP_PORT ?? 9224));
try {
  assert.equal(await page.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')`), 'app.foldmark.mobile');
  await page.evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click()`);
  const point = await page.evaluate(`(()=>{const line=[...document.querySelectorAll('.cm-line')].find(line=>line.textContent.includes('电脑段落'));if(!line)throw Error('请打开同步验收文档');const range=document.createRange();const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);range.selectNodeContents(walker.nextNode());const r=range.getBoundingClientRect();return{x:Math.round((r.x+15)*devicePixelRatio),y:Math.round((r.y+r.height/2)*devicePixelRatio)}})()`);
  run('shell', 'input', 'swipe', String(point.x), String(point.y), String(point.x), String(point.y), '1200');
  await new Promise(resolve => setTimeout(resolve, 600));
  const selection = await page.evaluate(`document.getSelection()?.toString()`);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/android-selection.png', execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p']));
  // Vivo 的浮动操作菜单不进入 UIAutomator 层级；菜单是否可见须检查真机截图，不能将缺少 XML 节点判为失败。
  console.log({ selection, screenshot: 'test-results/android-selection.png', menuVerification: '查看截图或在手机确认复制菜单' });
  assert(selection, '长按应选中正文');
} finally { page.close(); }
