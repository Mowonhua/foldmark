/** 在真实浏览器中验收同步接收后的阅读位置：替换正文不得让视口顶部原文行跳动。 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: process.env.TASKRAIL_BROWSER ?? 'msedge', headless: true });
try {
 for (const mobile of [true, false]) {
  const platform = mobile ? '手机' : '桌面';
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(`${process.env.TASKRAIL_URL ?? 'http://127.0.0.1:1420'}/tests/browser-sync-scroll.html${mobile ? '?mobile' : ''}`);
  await page.getByRole('button', { name: '验证阅读位置' }).click();
  await page.waitForFunction(() => document.getElementById('result')?.textContent?.includes('"pass"'));
  const result = JSON.parse(await page.locator('#result').textContent());
  for (const scenario of result.scenarios) {
    assert(scenario.pass, `${platform} ${scenario.name}：接收同步后顶行偏移 ${Number.isFinite(scenario.offsetDifference) ? scenario.offsetDifference.toFixed(2) : '无法定位'} px，过程峰值偏移 ${Number.isFinite(scenario.peakDrift) ? scenario.peakDrift.toFixed(2) : '锚点行离开视口'} px，丢失帧 ${scenario.lostFrames}`);
  }
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/sync-scroll-${mobile ? 'mobile' : 'desktop'}.png` });
  assert.deepEqual(failures, []);
  console.log(`${platform}同步阅读位置验收通过：${result.scenarios.map(scenario => `${scenario.name}（峰值 ${scenario.peakDrift.toFixed(2)} px）`).join('、')}。`);
  await page.close();
 }
} finally { await browser.close(); }
