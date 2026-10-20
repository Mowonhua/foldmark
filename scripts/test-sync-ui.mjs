/** 同一同步组件覆盖桌面、手机、配对、待接收与冲突，检查关闭与合并操作不会被滚动移走。 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: process.env.TASKRAIL_BROWSER ?? 'msedge', headless: true });
const failures = [];
await mkdir('test-results', { recursive: true });
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 850 }, isMobile: mobile, hasTouch: mobile });
    page.on('pageerror', error => failures.push(error.message));
    for (const scenario of ['paired', 'unpaired', 'incoming', 'conflict', 'conflict-many', 'error']) {
      await page.goto(`${process.env.TASKRAIL_URL ?? 'http://127.0.0.1:1420'}/tests/sync-preview.html?case=${scenario}${mobile ? '&mobile' : ''}`);
      await page.getByRole('dialog', { name: '设备同步' }).waitFor();
      if (scenario === 'paired') {
        assert.deepEqual(await page.locator('.sync-document-name').allTextContents(), ['工作清单', '产品设计笔记', '旅行计划', '灵感'], '已归档项目不出现在同步清单，仍在同步的归档项目保留一行');
        assert(await page.locator('.sync-document-row').filter({ hasText: '产品设计笔记' }).getByRole('checkbox').isChecked(), '仍在同步的归档项目仍可取消选择');
      }
      if (scenario === 'unpaired' && !mobile) {
        await page.getByRole('button', { name: '显示配对二维码' }).click();
        const code = page.locator('.sync-qr');
        await code.waitFor();
        await page.getByRole('button', { name: '放大配对二维码' }).click();
        const zoomed = page.locator('.sync-qr-zoom img');
        await zoomed.waitFor();
        assert.equal(await zoomed.getAttribute('src'), await code.getAttribute('src'), '放大层显示与面板内相同的二维码');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.sync-qr-zoom').count(), 0, '按 Esc 关闭放大层');
        assert.equal(await page.locator('.sync-qr').count(), 1, '关闭放大层后配对面板保持打开');
        await page.getByRole('button', { name: '放大配对二维码' }).click();
        await page.locator('.sync-qr-zoom').click();
        assert.equal(await page.locator('.sync-qr-zoom').count(), 0, '点击放大层后关闭');
        assert.equal(await page.locator('.sync-qr').count(), 1, '关闭放大层后配对面板保持打开');
      }
      if (scenario === 'conflict') {
        await page.getByRole('button', { name: '比较并处理' }).click();
        const merged = page.locator('textarea[aria-label="合并结果"]');
        const save = page.getByRole('button', { name: '保存合并' });
        const overlap = page.getByRole('group', { name: '第 1 处采用的改动' });
        const union = page.getByRole('group', { name: '第 2 处采用的改动' });
        assert.equal(await overlap.count(), 1, '两端改了同一段内容时列出该处差异');
        assert.equal(await union.count(), 1, '两端各自新增内容时也列出差异块');
        assert.equal(await union.getByRole('button', { name: '两端' }).count(), 1, '两端改动可并存时才提供「两端」选项');
        assert(await save.isDisabled(), '差异块未选择时不能保存');
        const initial = await merged.inputValue();
        assert(!initial.includes('本机整理后的设计反馈') && !initial.includes('手机整理后的设计反馈'), '合并结果不得预填任一端改动');
        assert(initial.includes('本机补充的说明') && initial.includes('手机补充的说明'), '两端各自新增的内容默认同时保留');
        await page.screenshot({ path: `test-results/sync-${mobile ? 'mobile' : 'desktop'}-merge.png` });
        await union.getByRole('button', { name: '两端' }).click();
        assert(await save.isDisabled(), '仍有差异块未选择时不能保存');
        const unioned = await merged.inputValue();
        assert(unioned.includes('本机补充的说明') && unioned.includes('手机补充的说明'), '选择「两端」后合并结果同时保留两端新增');
        await overlap.getByRole('button', { name: '本机', exact: true }).click();
        assert((await merged.inputValue()).includes('本机整理后的设计反馈'), '选择本机后合并结果采用本机那一侧');
        assert(!(await save.isDisabled()), '差异块选择完成后可以保存');
        await merged.fill('# 工作清单\n\n两端合并后的设计反馈。\n');
        assert(!(await save.isDisabled()), '编辑合并结果后可以保存');
      }
      if (scenario === 'conflict-many') {
        await page.getByRole('button', { name: '比较并处理' }).click();
        const save = page.getByRole('button', { name: '保存合并' });
        const needs = page.locator('.sync-hunk-needs');
        assert.equal(await page.locator('.sync-hunk').count(), 6, '每处差异单独成块');
        assert.equal(await needs.count(), 3, '两端改动同一段内容的差异块需要选择');
        assert((await page.locator('.sync-hunk-heading').nth(3).innerText()).includes('两端改动相同'), '两端改动结果相同的差异块直接采纳并如实标注');
        assert(await save.isDisabled(), '仍有差异块未选择时不能保存');
        await page.screenshot({ path: `test-results/sync-${mobile ? 'mobile' : 'desktop'}-many-conflicts.png` });
        await needs.nth(0).getByRole('button', { name: '本机', exact: true }).click();
        await needs.nth(1).getByRole('button', { name: '对端', exact: true }).click();
        assert(await save.isDisabled(), '还有未选择的差异块时仍不能保存');
        await needs.nth(2).getByRole('button', { name: '本机', exact: true }).click();
        assert(!(await save.isDisabled()), '所有差异块选择完成后可以保存');
        await page.locator('.sync-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.screenshot({ path: `test-results/sync-${mobile ? 'mobile' : 'desktop'}-many-resolved.png` });
      }
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
    await page.goto(`${process.env.TASKRAIL_URL ?? 'http://127.0.0.1:1420'}/tests/sync-preview.html?case=incoming${mobile ? '&mobile' : ''}`);
    await page.getByRole('button', { name: '接收文档', exact: true }).click();
    await page.getByRole('combobox', { name: '接收文档保存到' }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('withdraw-preview')));
    await page.getByRole('heading', { name: '设备同步', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '接收文档', exact: true }).count(), 0, '撤回时关闭正在打开的接收表单');
    await page.goto(`${process.env.TASKRAIL_URL ?? 'http://127.0.0.1:1420'}/tests/sync-preview.html?long${mobile ? '&mobile' : ''}`);
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
      await page.goto(`${process.env.TASKRAIL_URL ?? 'http://127.0.0.1:1420'}/tests/sync-preview.html?theme=${theme}&mode=${mode}${mobile ? '&mobile' : ''}`);
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
  console.log('同步界面验收通过：两端六种场景、窄屏宽度、无占位滚动条、固定关闭入口。');
} finally { await browser.close(); }
