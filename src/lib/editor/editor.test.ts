/** 文件职责：验证真实编辑器事务、历史隔离与投影交互。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorController, type EditorOptions } from './index';
import { indentTask, taskEnter } from './commands';
import { foldsField } from './state';

// jsdom 无布局引擎；空矩形保持事务测试不依赖浏览器几何尺寸。
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const editors: EditorController[] = [];
function editor(text: string, options: Partial<EditorOptions> = {}): EditorController {
  const parent = document.createElement('div');
  document.body.append(parent);
  const instance = new EditorController(parent, { text, mode: 'todo', onChange: () => {}, ...options });
  editors.push(instance);
  return instance;
}
afterEach(() => { for (const instance of editors.splice(0)) instance.destroy(); document.body.replaceChildren(); });

describe('唯一文档编辑事务', () => {
  it('完成移动正文到文末归档，撤销恢复任务标记和布局', () => {
    const instance = editor('- [ ] 写作\n  正文\n- [ ] 校对');
    instance.toggleTask(0);
    expect(instance.text).toBe('- [ ] 校对\n\n# 归档\n\n- [x] 写作\n  正文\n');
    expect(instance.undo()).toBe(true);
    expect(instance.text).toBe('- [ ] 写作\n  正文\n- [ ] 校对');
  });
  it('整项排序保留正文并使光标及折叠跟随原条目，撤销整体恢复', () => {
    const instance = editor('- [ ] 甲\n  说明\n- [ ] 乙\n');
    instance.focusAt(7);
    instance.toggleFold(0);
    instance.moveItem(0, 'down');
    expect(instance.text).toBe('- [ ] 乙\n- [ ] 甲\n  说明\n');
    expect(instance.getUIState().folded).toHaveLength(1);
    instance.undo();
    expect(instance.text).toBe('- [ ] 甲\n  说明\n- [ ] 乙\n');
  });
  it('切换项目保存不同历史，源码模式完整显示', () => {
    const instance = editor('- [ ] 甲');
    instance.toggleTask(0);
    const first = instance.state;
    const ui = instance.getUIState();
    instance.setText('- [ ] 乙', true);
    expect(instance.undo()).toBe(false);
    instance.restoreState(first, ui);
    instance.undo();
    expect(instance.text).toBe('- [ ] 甲');
    instance.setMode('source');
    expect(instance.getUIState().mode).toBe('source');
  });
  it('拒绝隐式完成未完成的整组，明确整组命令可整体撤销', () => {
    const instance = editor('- [ ] 父\n  - [ ] 子');
    instance.toggleTask(0);
    expect(instance.text).toBe('- [ ] 父\n  - [ ] 子');
    instance.toggleTask(0, true);
    expect(instance.text).toBe('# 归档\n\n- [x] 父\n  - [x] 子');
    instance.undo();
    expect(instance.text).toBe('- [ ] 父\n  - [ ] 子');
  });
  it('Enter 只处理任务首行，Shift Enter 保留正文结构，整项缩进包含后代', () => {
    const instance = editor('- [ ] 甲\n- [ ] 乙\n  正文');
    instance.focusAt(7);
    expect(taskEnter(instance.view)).toBe(true);
    expect(instance.text).toBe('- [ ] 甲\n- [ ] \n- [ ] 乙\n  正文');
    expect(taskEnter(instance.view)).toBe(true);
    expect(instance.text).toBe('- [ ] 甲\n\n- [ ] 乙\n  正文');
    instance.focusAt(instance.text.indexOf('乙') + 1);
    expect(indentTask(instance.view, 1)).toBe(true);
    expect(instance.text).toContain('  - [ ] 乙\n    正文');
    expect(taskEnter(instance.view, true)).toBe(true);
    expect(instance.text).toContain('  - [ ] 乙\n    \n    正文');
    instance.focusAt(instance.text.length);
    expect(taskEnter(instance.view)).toBe(false);
  });
  it('IME 组合阶段不提交任务命令', () => {
    const instance = editor('- [ ] 中文');
    instance.focusAt(instance.text.length);
    Object.defineProperty(instance.view, 'composing', { value: true });
    expect(taskEnter(instance.view)).toBe(false);
    expect(indentTask(instance.view, 1)).toBe(false);
    expect(instance.text).toBe('- [ ] 中文');
  });
  it('未激活 Markdown 显示语义排版，源码切换不改写原文', () => {
    const source = '# 标题\n\n**强调** 与 *中文斜体*、_italic_、~~删除~~、`代码`、[链接](https://example.com)\n\n$x^2$\n\n$$x+y$$\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n末尾';
    const instance = editor(source);
    instance.focusAt(source.length);
    expect(instance.view.dom.querySelector('.fm-h1')).not.toBeNull();
    expect(instance.view.dom.querySelector('.fm-strong')).not.toBeNull();
    expect(Array.from(instance.view.dom.querySelectorAll('.fm-em'), node => node.textContent)).toEqual(['中文斜体', 'italic']);
    expect(instance.view.dom.querySelector('.fm-math-inline .katex')).not.toBeNull();
    expect(instance.view.dom.querySelector('.fm-math-block .katex')).not.toBeNull();
    expect(instance.view.dom.querySelector('table')).not.toBeNull();
    instance.setMode('source');
    expect(instance.view.dom.querySelector('.fm-task-checkbox')).toBeNull();
    expect(instance.text).toBe(source);
  });
  it('折叠只收拢相交选区，搜索定位展开祖先且不进入文本撤销', () => {
    const instance = editor('- [ ] 父\n  - [ ] 子\n    正文\n- [ ] 后');
    const childFrom = instance.model.tasks[1].from;
    instance.toggleFold(childFrom);
    instance.focusAt(7);
    instance.toggleFold(0);
    expect(instance.state.field(foldsField).size).toBe(2);
    instance.toggleFold(0);
    expect(instance.state.field(foldsField).has(childFrom)).toBe(true);
    instance.focusAt(instance.text.indexOf('正文'));
    expect(instance.state.field(foldsField).size).toBe(0);
    expect(instance.undo()).toBe(false);
  });
  it('归档只读但允许键盘恢复任务，恢复后回到原文位置', () => {
    const instance = editor('- [x] 完成\n- [ ] 待办');
    instance.setMode('archive');
    expect(instance.state.readOnly).toBe(true);
    const checkbox = instance.view.dom.querySelector<HTMLButtonElement>('[role=checkbox]');
    expect(checkbox?.getAttribute('aria-checked')).toBe('true');
    checkbox?.click();
    expect(instance.text).toBe('- [ ] 完成\n- [ ] 待办');
    expect(instance.undo()).toBe(true);
    expect(instance.text).toBe('- [x] 完成\n- [ ] 待办');
    expect(instance.state.readOnly).toBe(true);
  });
  it('归档上下文菜单恢复不会误执行完成整组', () => {
    const instance = editor('- [x] 完成\n  - [x] 子项');
    instance.setMode('archive');
    const marker = instance.view.dom.querySelector('[role=checkbox]')!;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const restore = [...document.querySelectorAll<HTMLButtonElement>('.fm-item-menu button')].find(button => button.textContent === '恢复任务');
    restore?.click();
    expect(instance.text).toBe('- [ ] 完成\n\n# 归档\n\n- [x] 子项');
  });
  it('未闭合公式提供局部提示，代码围栏就地预览后源码仍完整', () => {
    const source = '公式 $x + y\n\n```ts\nconst x = 1;\n```\n\n末尾';
    const instance = editor(source);
    instance.focusAt(source.length);
    expect(instance.view.dom.querySelector('.fm-math-error')?.getAttribute('title')).toContain('未闭合');
    expect(instance.view.contentDOM.textContent).toContain('const x = 1;');
    expect(instance.view.contentDOM.textContent).not.toContain('```');
    const code = instance.view.contentDOM.querySelector('.fm-code-line')!;
    expect(code.classList.contains('fm-code-start')).toBe(true);
    expect(code.classList.contains('fm-code-end')).toBe(true);
    instance.setMode('source');
    expect(instance.text).toBe(source);
  });
  it('多行、缩进及未闭合代码块保持正文边框，进入编辑也不展开围栏', () => {
    const source = '```ts\nconst a = 1;\nconst b = 2;\n```\n\n正文\n\n    indented\n    code\n\n末尾';
    const instance = editor(source); instance.focusAt(source.length);
    const starts = [...instance.view.contentDOM.querySelectorAll('.fm-code-start')];
    const ends = [...instance.view.contentDOM.querySelectorAll('.fm-code-end')];
    expect(starts.map(node => node.textContent)).toEqual(['const a = 1;', '    indented']);
    expect(ends.map(node => node.textContent)).toEqual(['const b = 2;', '    code']);
    instance.focusAt(1);
    expect(instance.view.contentDOM.querySelector('.fm-code-start')?.textContent).toBe('const a = 1;');
    expect(instance.view.contentDOM.querySelector('.fm-code-end')?.textContent).toBe('const b = 2;');
    expect(instance.view.contentDOM.textContent).not.toContain('```');
    instance.setMode('source');
    expect(instance.view.contentDOM.textContent).toContain('```ts');
    const unclosed = editor('正文\n\n```\nfirst\nlast');
    expect(unclosed.view.contentDOM.querySelector('.fm-code-start')?.textContent).toBe('first');
    expect(unclosed.view.contentDOM.querySelector('.fm-code-end')?.textContent).toBe('last');
  });
  it('Setext 标题与表格单元格组合语法按同一语法树排版', () => {
    const source = '主标题\n======\n\n| **重点** | [*链接*](https://example.com/a(b)) | $x^2$ |\n| --- | :---: | ---: |\n| ~~删除~~ | `代码` | 转义 \\| 竖线 |\n\n末尾';
    const instance = editor(source); instance.focusAt(source.length);
    expect(instance.view.dom.querySelector('.fm-h1')?.textContent).toContain('主标题');
    const table = instance.view.dom.querySelector('table')!;
    expect(table.querySelector('strong')?.textContent).toBe('重点');
    expect(table.querySelector('a em')?.textContent).toBe('链接');
    expect(table.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a(b)');
    expect(table.querySelector('.katex')).not.toBeNull();
    expect(table.querySelector('del')?.textContent).toBe('删除');
    expect(table.querySelector('code')?.textContent).toBe('代码');
    expect(table.textContent).toContain('转义 | 竖线');
    instance.setMode('source'); expect(instance.text).toBe(source);
  });
  it('引用式链接与图片解析规范化标签并优先使用首个定义，源码保持完整', () => {
    const source = '[**完整**][Foo Bar] [foo bar][] [foo bar] ![图片][pic]\n\n[foo   BAR]: <https://example.com/a?x=1&amp;y=2> "说明"\n[foo bar]: https://wrong.example\n[pic]: images/a.png\n\n末尾';
    const instance = editor(source, { resolveResource: url => url.startsWith('images/') ? `https://assets.example/${url}` : url });
    instance.focusAt(source.length);
    const links = [...instance.view.dom.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links).toHaveLength(3);
    expect(links.every(link => link.getAttribute('href') === 'https://example.com/a?x=1&y=2')).toBe(true);
    expect(links[0].querySelector('strong')?.textContent).toBe('完整');
    expect(links[0].title).toContain('说明');
    expect(instance.view.dom.querySelector('img.fm-image')?.getAttribute('src')).toBe('https://assets.example/images/a.png');
    expect(instance.view.contentDOM.textContent).not.toContain('wrong.example');
    instance.setMode('source'); expect(instance.text).toBe(source);
  });
  it('自动链接、GFM裸URL与表格引用共用打开端口，危险协议不能激活', () => {
    const source = '<https://example.com> <a@example.com> https://example.org/a www.example.net b@example.org\n\n| 链接 | 公式 |\n| --- | --- |\n| [*表内*][ref] | $x$ |\n\n[ref]: https://table.example\n[bad]: javascript:alert(1)\n\n[危险][bad] 与 `https://code.example`\n\n末尾';
    const openLink = vi.fn();
    const instance = editor(source, { openLink }); instance.focusAt(source.length);
    const links = [...instance.view.dom.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.map(link => link.getAttribute('href'))).toEqual(expect.arrayContaining(['https://example.com', 'mailto:a@example.com', 'https://example.org/a', 'http://www.example.net', 'mailto:b@example.org', 'https://table.example']));
    expect(instance.view.dom.querySelector('table a em')?.textContent).toBe('表内');
    const automatic = links.find(link => link.getAttribute('href') === 'mailto:a@example.com')!;
    automatic.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(openLink).toHaveBeenCalledWith('mailto:a@example.com');
    const dangerous = links.find(link => link.textContent === '危险')!;
    expect(dangerous.hasAttribute('href')).toBe(false);
    dangerous.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(links.some(link => link.href === 'https://code.example/')).toBe(false);
    expect(instance.text).toBe(source);
  });
  it('复选框按下不完成，原控件松开才完成，拖动取消不能触发单击', () => {
    const instance = editor('- [ ] 甲\n- [ ] 乙');
    const marker = instance.view.dom.querySelector<HTMLButtonElement>('[role=checkbox]')!;
    marker.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }));
    expect(instance.text).toContain('- [ ] 甲');
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 20 }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 0, clientY: 0 }));
    expect(instance.text).toContain('- [ ] 甲');
    marker.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(instance.text).toContain('- [x] 甲');
  });
  it('完成立即移入归档且后续时间流逝不增加撤销步骤', async () => {
    vi.useFakeTimers();
    try {
      const instance = editor('- [ ] 甲\n- [ ] 乙');
      instance.toggleTask(0);
      expect(instance.text).toContain('- [x] 甲');
      expect(instance.text).toContain('# 归档');
      expect(instance.view.dom.querySelector('[aria-checked=true]')).toBeNull();
      await vi.advanceTimersByTimeAsync(150);
      expect(instance.view.dom.querySelector('[aria-checked=true]')).toBeNull();
      instance.undo();
      expect(instance.text).toBe('- [ ] 甲\n- [ ] 乙');
    } finally { vi.useRealTimers(); }
  });
  it('丢失指针捕获会取消拖动，松开不能把任务误完成', () => {
    const instance = editor('- [ ] 甲\n- [ ] 乙');
    const marker = instance.view.dom.querySelector<HTMLButtonElement>('[role=checkbox]')!;
    marker.setPointerCapture = vi.fn(); marker.hasPointerCapture = () => true; marker.releasePointerCapture = vi.fn();
    const down = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
    Object.defineProperty(down, 'pointerId', { value: 7 });
    marker.dispatchEvent(down);
    expect(marker.setPointerCapture).toHaveBeenCalledWith(7);
    marker.dispatchEvent(new Event('lostpointercapture'));
    const up = new MouseEvent('pointerup'); Object.defineProperty(up, 'pointerId', { value: 7 }); window.dispatchEvent(up);
    expect(instance.text).toBe('- [ ] 甲\n- [ ] 乙');
    expect(marker.releasePointerCapture).toHaveBeenCalledWith(7);
  });
});
