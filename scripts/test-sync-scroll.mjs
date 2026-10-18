/** 在真实浏览器中验收同步接收后的阅读位置：替换正文不得让视口顶部原文行跳动。 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: process.env.FOLDMARK_BROWSER ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const failures = [];
page.on('pageerror', error => failures.push(error.message));
try {
  await page.goto(`${process.env.FOLDMARK_URL ?? 'http://127.0.0.1:1420'}/tests/browser-sync-scroll.html`);
  await page.getByRole('button', { name: '验证阅读位置' }).click();
  await page.waitForFunction(() => document.getElementById('result')?.textContent?.includes('"pass"'));
  const result = JSON.parse(await page.locator('#result').textContent());
  for (const scenario of result.scenarios) {
    assert(scenario.pass, `${scenario.name}：接收同步后顶行偏移 ${Number.isFinite(scenario.offsetDifference) ? scenario.offsetDifference.toFixed(2) : '无法定位'} px`);
  }
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/sync-scroll-preserved.png' });
  assert.deepEqual(failures, []);
  console.log(`同步阅读位置验收通过：${result.scenarios.map(scenario => scenario.name).join('、')} 均保持顶部行与像素偏移。`);
} finally { await browser.close(); }
