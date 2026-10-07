/**
 * 文件职责：验证更新说明渲染的结构、降级与安全边界。
 * 定义范围：块级结构、任务列表、链接协议白名单、图片降级、原始 HTML 拦截与实体解码。
 */
import { describe, expect, it } from 'vitest';
import { renderReleaseNotes } from './release-notes';

function render(source: string): HTMLDivElement {
  const container = document.createElement('div');
  container.append(renderReleaseNotes(source));
  return container;
}

describe('更新说明渲染', () => {
  it('标题、段落、列表、引用和分隔线渲染为对应元素，嵌套列表保持层级', () => {
    const container = render('## 修复\n\n一段说明文字。\n\n- 项目甲\n  - 子项\n- 项目乙\n\n1. 第一步\n\n> 引用文字\n\n---\n');
    expect(container.innerHTML).toContain('<h2>修复</h2>');
    expect(container.innerHTML).toContain('<p>一段说明文字。</p>');
    expect(container.innerHTML).toContain('<ul><li>项目甲<ul><li>子项</li></ul></li><li>项目乙</li></ul>');
    expect(container.innerHTML).toContain('<ol><li>第一步</li></ol>');
    expect(container.innerHTML).toContain('<blockquote><p>引用文字</p></blockquote>');
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('任务列表渲染为禁用复选框并保留完成状态与行内样式', () => {
    const container = render('- [x] 已完成 **加粗**\n- [ ] 待处理\n');
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[0].disabled).toBe(true);
    expect(boxes[1].checked).toBe(false);
    expect(container.querySelector('li strong')?.textContent).toBe('加粗');
  });

  it('链接只放行网页与非空邮件协议，其余目标降级为纯文本标签', () => {
    const container = render('[官网](https://example.com/a?b=1) [邮件](mailto:a@b.com) [脚本](javascript:alert(1)) [相对](./x.md) 空目标 []()');
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[1].getAttribute('href')).toBe('mailto:a@b.com');
    expect(container.textContent).toContain('脚本');
    expect(container.querySelector('a[href="javascript:alert(1)"]')).toBeNull();
  });

  it('自动链接补全协议并渲染，引用式链接解析顶层定义且定义本身不输出', () => {
    const container = render('访问 https://example.com 与 <https://example.com/x>，见 [说明][ref]。\n\n[ref]: https://example.com/docs\n');
    const links = [...container.querySelectorAll('a')].map(link => link.getAttribute('href'));
    expect(links).toEqual(['https://example.com', 'https://example.com/x', 'https://example.com/docs']);
    expect(container.textContent).not.toContain('[ref]:');
  });

  it('图片只放行网页和图片类 data 地址，不安全目标保留替代文字', () => {
    const container = render('![截图](https://example.com/a.png) ![数据](data:image/png;base64,AAAA) ![坏](javascript:alert(1))');
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);
    expect(images[0].getAttribute('src')).toBe('https://example.com/a.png');
    expect(images[0].getAttribute('alt')).toBe('截图');
    expect(images[1].getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(container.textContent).toContain('坏');
  });

  it('原始 HTML 不透传，字符引用与转义按纯文本解码', () => {
    const container = render('<div onclick="alert(1)">点击</div>\n\nA &amp; B \\<x\\> \\* not em\n');
    expect(container.innerHTML).not.toContain('<div');
    expect(container.innerHTML).not.toContain('onclick');
    expect(container.textContent).toContain('A & B <x> * not em');
  });

  it('表格带表头、对齐与空单元格补列', () => {
    const container = render('| 模块 | 状态 |\n| :--- | ---: |\n| 核心 | 完成 |\n| 空 | |\n');
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll('th')).toHaveLength(2);
    const cells = table!.querySelectorAll('td');
    expect(cells).toHaveLength(4);
    expect(cells[0].textContent).toBe('核心');
    expect(cells[1].textContent).toBe('完成');
    expect(cells[3].textContent).toBe('');
    expect(table!.querySelectorAll('th')[1].style.textAlign).toBe('right');
  });

  it('围栏代码剥去围栏行输出等宽正文，未闭合围栏保留最后一行', () => {
    expect(render('```js\nconst a = 1;\n```\n').innerHTML).toContain('<pre><code>const a = 1;</code></pre>');
    expect(render('```\n未闭合的内容行\n').innerHTML).toContain('<pre><code>未闭合的内容行</code></pre>');
    expect(render('```\n```\n').querySelector('pre')).toBeNull();
  });

  it('不套用公式扩展，普通美元文本保持原样', () => {
    expect(render('价格 $5 与 $10。').innerHTML).toContain('<p>价格 $5 与 $10。</p>');
  });

  it('Setext 标题映射层级，行内代码与删除线渲染为对应元素', () => {
    const container = render('主标题\n====\n正文 `代码` 与 ~~删除~~\n');
    expect(container.querySelector('h1')?.textContent).toBe('主标题');
    expect(container.querySelector('code')?.textContent).toBe('代码');
    expect(container.querySelector('del')?.textContent).toBe('删除');
  });
});
