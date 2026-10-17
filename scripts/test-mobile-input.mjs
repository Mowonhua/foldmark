/** 真实触屏事件与 DOM 文本输入覆盖底部留白及隐藏归档，不使用直接替换编辑器正文的方式模拟输入。 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const source = '# 留白验收\n\n- [ ] 任务\n\n# 归档\n\n- [x] 完成\n';
try {
  await page.addInitScript(source => {
    localStorage.setItem('foldmark:file:blank.md', JSON.stringify({ path: 'blank.md', text: source, revision: 'initial' }));
    localStorage.setItem('foldmark:config', JSON.stringify({ projects: [{ id: 'blank', name: '留白验收', path: 'blank.md' }], activeProjectId: 'blank', preferences: { theme: 'light', fontFamily: 'sans-serif', fontSize: 16, contentWidth: 800 }, projectViews: {} }));
  }, source);
  await page.goto('http://127.0.0.1:1420/?mobile-preview');
  await page.waitForSelector('.app-shell.booted .cm-content');
  const bounds = await page.locator('.cm-scroller').boundingBox();
  await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height - 80);
  await page.keyboard.insertText('留白输入保留');
  await page.waitForTimeout(800);
  const actual = await page.evaluate(() => JSON.parse(localStorage.getItem('foldmark:file:blank.md')).text);
  assert(actual.includes('任务\n\n留白输入保留'), `底部输入没有成为可见正文：${JSON.stringify(actual)}`);
  assert(actual.endsWith('# 归档\n\n- [x] 完成\n'));
  await page.screenshot({ path: 'test-results/mobile-blank-input.png' });
  console.log('手机底部留白输入通过，归档原文保持不变。');
} finally { await browser.close(); }
