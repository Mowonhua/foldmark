/** 在真实触屏浏览器中验证浮层外部关闭与导航手势。 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: process.env.FOLDMARK_BROWSER ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await page.addInitScript(() => {
  localStorage.setItem('foldmark:file:navigation.md', JSON.stringify({ path: 'navigation.md', text: '# 手机导航\n\n- [ ] 任务\n', revision: 'initial' }));
  localStorage.setItem('foldmark:config', JSON.stringify({ projects: [{ id: 'navigation', name: '手机导航', path: 'navigation.md' }], activeProjectId: 'navigation', preferences: { theme: 'light' }, projectViews: {} }));
});
try {
  await page.goto(`${process.env.FOLDMARK_URL ?? 'http://127.0.0.1:1420'}/?mobile-preview`);
  await page.waitForSelector('.app-shell.booted');
  for (const [trigger, popup] of [['更多操作', '[data-more-menu][role="menu"]'], ['搜索', '.search-panel'], ['切换项目', '.crumb-menu']]) {
    await page.getByRole('button', { name: trigger, exact: true }).tap();
    await page.locator(popup).waitFor();
    await page.touchscreen.tap(350, 730);
    await page.waitForTimeout(80);
    assert.equal(await page.locator(popup).count(), 0, `${trigger}在正文空白处触屏按下后关闭`);
  }
  await page.getByRole('button', { name: '更多操作', exact: true }).tap();
  assert.equal(await page.getByRole('menuitem', { name: '快捷键', exact: true }).count(), 0);
  assert.equal(await page.getByRole('menuitem', { name: '检查更新', exact: true }).count(), 1);
  await page.touchscreen.tap(350, 730);
  // 弹窗外触屏只关闭弹窗，不把焦点交回正文（否则会立即唤起输入法）。
  await page.locator('[aria-label="Markdown 任务文档"]').tap();
  await page.getByRole('button', { name: '更多操作', exact: true }).tap();
  await page.getByRole('menuitem', { name: '新增项目', exact: true }).tap();
  await page.locator('.modal[role="dialog"]').first().waitFor();
  await page.touchscreen.tap(350, 730);
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.modal[role="dialog"]').count(), 0, '弹窗外触屏关闭弹窗');
  assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Markdown 任务文档', '弹窗外关闭后焦点不落回正文');
  const cdp = await page.context().newCDPSession(page);
  async function swipe(x, y, dx, dy = 0) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }] });
      // 每步跨过一个绘制帧，避免 CDP 合并的上一轮移动事件迟到下一次手势。
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(230);
  }
  await swipe(10, 400, 130);
  assert.equal(await page.locator('.sidebar').count(), 1, '左侧向右滑动展开导航');
  await swipe(180, 400, -130);
  assert.equal(await page.locator('.sidebar').count(), 0, '向左滑动收起导航');
  await swipe(10, 500, 10, -160);
  assert.equal(await page.locator('.sidebar').count(), 0, '纵向滚动不展开导航');
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await swipe(width * 0.49, 450, 80);
    assert.equal(await page.locator('.sidebar').count(), 1, `${width}px 视口左侧 49% 处右滑展开导航`);
    await swipe(180, 450, -130);
    assert.equal(await page.locator('.sidebar').count(), 0);
    await swipe(width * 0.51, 450, 80);
    assert.equal(await page.locator('.sidebar').count(), 0, `${width}px 视口右侧 51% 处右滑不展开导航`);
  }
  console.log('手机导航验收通过：三个浮层外部关闭、弹窗外部关闭不聚焦正文、快捷键入口移除、更新入口、左右滑动与纵向滚动隔离。');
} finally { await browser.close(); }
