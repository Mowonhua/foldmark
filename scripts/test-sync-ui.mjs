/** 同一同步组件覆盖桌面、手机、配对、待接收与冲突，检查关闭与合并操作不会被滚动移走。 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: process.env.FOLDMARK_BROWSER ?? 'msedge', headless: true });
const failures = [];
await mkdir('test-results', { recursive: true });
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 850 }, isMobile: mobile, hasTouch: mobile });
    page.on('pageerror', error => failures.push(error.message));
    for (const scenario of ['paired', 'unpaired', 'incoming', 'conflict', 'error']) {
      await page.goto(`${process.env.FOLDMARK_URL ?? 'http://127.0.0.1:1420'}/tests/sync-preview.html?case=${scenario}${mobile ? '&mobile' : ''}`);
      await page.getByRole('dialog', { name: '设备同步' }).waitFor();
      if (scenario === 'unpaired' && !mobile) await page.getByRole('button', { name: '显示配对二维码' }).click();
      if (scenario === 'conflict') await page.getByRole('button', { name: '比较并处理' }).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '同步页面不能横向溢出');
      const close = await page.getByRole('button', { name: '关闭同步面板' }).boundingBox();
      assert(close && close.y >= 0 && close.y + close.height <= (mobile ? 844 : 850));
      if (mobile) {
        const box = await page.getByRole('dialog').boundingBox(); assert.equal(Math.round(box.width), 390);
        assert(await page.locator('.sync-body').evaluate(node => node.offsetWidth === node.clientWidth), '手机滚动条不得占据布局宽度');
      }
      await page.screenshot({ path: `test-results/sync-${mobile ? 'mobile' : 'desktop'}-${scenario}.png` });
      if (scenario === 'incoming') {
        await page.getByRole('button', { name: '接收文档', exact: true }).click();
        const target = page.getByRole('combobox', { name: '接收文档保存到' });
        assert.deepEqual(await target.locator('option').allTextContents(), ['新建项目', '关联：旅行计划']);
        await target.selectOption('local-2');
        await page.screenshot({ path: `test-results/sync-${mobile ? 'mobile' : 'desktop'}-mapping.png` });
        await page.getByRole('button', { name: '关联项目', exact: true }).click();
        await page.getByRole('heading', { name: '合并文档', exact: true }).waitFor();
        assert((await page.locator('textarea[aria-label="本机正文"]').inputValue()).includes('设计反馈'));
        assert.equal(await page.locator('textarea[aria-label="对端正文"]').inputValue(), '新文档');
      }
    }
    await page.goto(`${process.env.FOLDMARK_URL ?? 'http://127.0.0.1:1420'}/tests/sync-preview.html?case=incoming${mobile ? '&mobile' : ''}`);
    await page.getByRole('button', { name: '接收文档', exact: true }).click();
    await page.getByRole('combobox', { name: '接收文档保存到' }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('withdraw-preview')));
    await page.getByRole('heading', { name: '设备同步', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '接收文档', exact: true }).count(), 0, '撤回时关闭正在打开的接收表单');
    await page.goto(`${process.env.FOLDMARK_URL ?? 'http://127.0.0.1:1420'}/tests/sync-preview.html?long${mobile ? '&mobile' : ''}`);
    const close = page.getByRole('button', { name: '关闭同步面板' }); await close.waitFor(); const before = await close.boundingBox();
    const connection = page.locator('.sync-connection-settings summary'); const connectionBefore = await connection.boundingBox();
    await page.locator(mobile ? '.sync-document-scroll' : '.sync-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert.deepEqual(await close.boundingBox(), before, '文档列表滚动时关闭入口保持可见');
    if (mobile) {
      assert(connectionBefore.y + connectionBefore.height <= 844, '长列表不能把连接设置挤出视口');
      assert.deepEqual(await connection.boundingBox(), connectionBefore, '文档滚动不移动连接设置');
      await connection.click();
      const input = await page.getByRole('textbox', { name: '电脑局域网地址' }).boundingBox();
      assert(input && input.width > 180 && input.y + input.height <= 844, '展开后的地址输入完整可见');
      await page.screenshot({ path: 'test-results/sync-mobile-fixed-settings.png' });
    }
    for (const theme of ['paper', 'mono', 'neumorphic', 'liquid-glass', 'frosted-glass']) for (const mode of ['light', 'dark']) {
      await page.goto(`${process.env.FOLDMARK_URL ?? 'http://127.0.0.1:1420'}/tests/sync-preview.html?theme=${theme}&mode=${mode}${mobile ? '&mobile' : ''}`);
      await page.getByRole('dialog').waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${mode} 不得横向溢出`);
      assert(await page.evaluate(() => {
        const reference = document.createElement('button'); reference.className = 'fm-task-checkbox'; reference.setAttribute('aria-checked', 'true'); document.body.append(reference);
        const check = document.querySelector('.sync-checkmark[data-checked=true]'); const expected = getComputedStyle(reference), actual = getComputedStyle(check);
        const matches = ['backgroundColor', 'borderColor', 'boxShadow', 'color'].every(key => expected[key] === actual[key]);
        const markMatches = getComputedStyle(reference, '::after').content === getComputedStyle(check, '::after').content;
        reference.remove(); return matches && markMatches;
      }), `${theme}/${mode} 同步复选框应与正文消费相同主题样式`);
      if (mobile && theme === 'neumorphic') await page.screenshot({ path: `test-results/sync-mobile-${theme}-${mode}.png` });
    }
    await page.close();
  }
  assert.deepEqual(failures, []);
  console.log('同步界面验收通过：两端五种状态、窄屏宽度、无占位滚动条、固定关闭入口。');
} finally { await browser.close(); }
