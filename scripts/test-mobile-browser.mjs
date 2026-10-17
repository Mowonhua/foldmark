/** 在真实浏览器中验证触屏布局与编辑入口；Android 生命周期另由真机验收。 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: process.env.FOLDMARK_BROWSER ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const failures = [];
page.on('pageerror', error => failures.push(error.message));
const source = '# 手机验收\n\n- [ ] 任务一\n\n  任务说明\n\n- [ ] 任务二\n\n' + Array.from({ length: 40 }, (_, i) => `- [ ] 后续任务 ${i + 1}\n\n`).join('');
await page.addInitScript(source => {
  localStorage.setItem('foldmark:file:mobile.md', JSON.stringify({ path: 'mobile.md', text: source, revision: 'initial' }));
  localStorage.setItem('foldmark:config', JSON.stringify({ projects: [{ id: 'mobile-test', name: '手机验收', path: 'mobile.md' }], activeProjectId: 'mobile-test', preferences: { theme: 'light', fontFamily: 'sans-serif', fontSize: 16, contentWidth: 800 }, projectViews: {} }));
}, source);
try {
  await page.goto(`${process.env.FOLDMARK_URL ?? 'http://127.0.0.1:1420'}/?mobile-preview`);
  await page.waitForFunction(() => document.querySelector('.app-shell.booted') && !document.querySelector('.sidebar'));
  assert.equal(await page.getByRole('button', { name: '进入卡片模式' }).count(), 0);
  const toolbar = page.getByRole('toolbar', { name: '编辑操作' });
  const before = await toolbar.boundingBox();
  await page.locator('.cm-scroller').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('.cm-scroller').scrollTop > 100);
  const after = await toolbar.boundingBox();
  assert.equal(before.y, after.y, '正文滚动不移动编辑辅助栏');
  await page.locator('.cm-scroller').evaluate(node => { node.scrollTop = 0; });
  await page.locator('.cm-line').filter({ hasText: '任务一' }).getByRole('checkbox', { name: '完成任务', exact: true }).tap();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('foldmark:file:mobile.md')).text.includes('- [x] 任务一'));
  await page.setViewportSize({ width: 320, height: 640 });
  const notification = await page.locator('.toast').evaluate(node => {
    const text = node.querySelector('span'), box = text.getBoundingClientRect();
    return { textHeight: box.height, lineHeight: parseFloat(getComputedStyle(text).lineHeight), right: node.getBoundingClientRect().right };
  });
  assert(notification.textHeight <= notification.lineHeight + 1, '短通知在窄屏保持单行，不能被操作按钮挤成一团');
  assert(notification.right <= 320, '通知不能超出视口');
  await page.screenshot({ path: 'test-results/mobile-toast-icons.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await toolbar.getByRole('button', { name: '撤销', exact: true }).tap();
  await page.waitForFunction(() => !JSON.parse(localStorage.getItem('foldmark:file:mobile.md')).text.includes('- [x] 任务一'));
  await page.getByRole('button', { name: '展开项目导航' }).tap();
  await page.waitForSelector('.drawer-scrim');
  await page.getByRole('button', { name: '关闭项目导航' }).tap({ position: { x: 375, y: 400 } });
  await page.waitForFunction(() => !document.querySelector('.sidebar'));
  const nativeContext = await page.locator('.cm-content').evaluate(node => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); node.dispatchEvent(event); return !event.defaultPrevented;
  });
  assert(nativeContext, '手机正文不能截获系统选字菜单');
  await page.getByRole('button', { name: '查看源码', exact: true }).tap();
  await page.getByRole('button', { name: '返回预览', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回预览', exact: true }).tap();
  await page.setViewportSize({ width: 320, height: 640 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '窄屏不能横向溢出');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/mobile-browser.png' });
  await page.getByRole('button', { name: '展开项目导航' }).tap();
  await page.getByRole('button', { name: '新增项目', exact: true }).tap();
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('手机直接新建');
  await page.getByRole('button', { name: '创建项目', exact: true }).tap();
  await page.waitForFunction(() => {
    const config = JSON.parse(localStorage.getItem('foldmark:config'));
    const project = config.projects.find(project => project.name === '手机直接新建');
    return project && config.activeProjectId === project.id && JSON.parse(localStorage.getItem(`foldmark:file:${project.path}`)).text.includes('# 手机直接新建');
  });
  assert.equal(await page.getByRole('dialog').count(), 0, '手机无需选择路径即可创建项目');
  assert.deepEqual(failures, []);
  console.log('移动浏览器验收通过：触屏勾选、撤销、导航抽屉、原生菜单、源码切换、固定辅助栏与窄屏布局。');
} finally { await browser.close(); }
