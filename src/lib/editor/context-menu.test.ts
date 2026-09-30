/** 文件职责：验证正文菜单的选区、事务边界和异步剪贴板意图。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { EditorController } from './index';
import type { ClipboardPort } from '../clipboard';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const instances: EditorController[] = [];
function setup(text = 'alpha beta', mode: 'todo' | 'archive' | 'source' = 'todo', clipboard: ClipboardPort = { readText: vi.fn().mockResolvedValue('paste'), writeText: vi.fn().mockResolvedValue(undefined) }) {
  const host = document.body.appendChild(document.createElement('div'));
  const status = vi.fn();
  const editor = new EditorController(host, { text, mode, onChange: () => {}, clipboard, onStatus: status });
  // 端口独立注入，异步验收不访问用户的系统剪贴板。
  instances.push(editor);
  const open = (position = 0) => {
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(position);
    editor.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 100 }));
    return document.querySelector<HTMLElement>('.fm-context-menu')!;
  };
  const action = (name: string) => document.querySelector<HTMLButtonElement>(`.fm-context-menu [data-command="${name}"]`)!;
  return { editor, clipboard, open, action, status };
}
afterEach(() => {
  for (const editor of instances.splice(0)) editor.destroy();
  vi.restoreAllMocks(); document.body.replaceChildren();
});
const settled = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('正文右键菜单', () => {
  it('真实空段落的 DOM 坐标优先于代码正文的几何误命中', () => {
    const text = '```\nx\n```\n\n\n\n';
    const { editor } = setup(text);
    editor.view.dispatch({ selection: { anchor: 4 } });
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(4);
    const line = editor.view.contentDOM.querySelector<HTMLElement>('[data-empty-paragraph-from]')!;
    const from = Number(line.dataset.emptyParagraphFrom);
    line.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    expect(editor.state.selection.main.head).toBe(from);
    expect(editor.text).toBe(text);
    expect(document.querySelector('.fm-context-menu [data-submenu="insert"]')).not.toBeNull();
  });
  it.each(['```\nx\n```', '$$\nx\n$$', '```\n```', '$$\n$$'])('文末 %s 块下方右键创建块外空段落并保持重复定位稳定', text => {
    const { editor } = setup(text);
    editor.view.dispatch({ selection: { anchor: 4 } });
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(text.length);
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 20, bottom: 40 });
    editor.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
    const click = () => editor.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 150 }));
    click(); expect(editor.text).toBe(text + '\n\n'); expect(editor.state.selection.main.head).toBe(text.length + 2);
    expect(document.querySelector('.fm-context-menu [data-submenu="insert"]')).not.toBeNull();
    click(); expect(editor.text).toBe(text + '\n\n'); expect(editor.state.selection.main.head).toBe(text.length + 2);
  });
  it('空围栏控件右键不会执行只为左键设计的激活插入', () => {
    const { editor } = setup('```\n```');
    const widget = editor.view.contentDOM.querySelector('.fm-empty-code')!;
    widget.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }));
    expect(editor.text).toBe('```\n```');
  });
  it('底部右键沿可见待办出口定位，不写入或选择隐藏归档', () => {
    const text = '- [ ] A\n\n# 归档\n\n- [x] hidden';
    const { editor } = setup(text);
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(text.length);
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 20, bottom: 40 });
    editor.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
    editor.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 150 }));
    expect(editor.text).toBe('- [ ] A\n\n\n\n# 归档\n\n- [x] hidden');
    expect(editor.state.selection.main.head).toBe(9);
    expect(document.querySelector('.fm-context-menu [data-submenu="insert"]')).not.toBeNull();
  });
  it('选区内空段落右键保持整个选区，源码底部空白不创建段落', () => {
    const { editor } = setup('A\n\n\n\nB');
    editor.view.dispatch({ selection: { anchor: 0, head: editor.text.length } });
    const selection = editor.state.selection;
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(2);
    editor.view.contentDOM.querySelector('[data-empty-paragraph-from]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    expect(editor.state.selection.eq(selection)).toBe(true); expect(editor.text).toBe('A\n\n\n\nB');
    const source = setup('```\nx\n```', 'source').editor;
    vi.spyOn(source.view, 'posAtCoords').mockReturnValue(source.text.length);
    vi.spyOn(source.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 20, bottom: 40 });
    source.view.contentDOM.getBoundingClientRect = () => new DOMRect(10, 0, 400, 300);
    source.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 150 }));
    expect(source.text).toBe('```\nx\n```');
  });
  it('段落间空行的右键提供 Markdown 插入菜单并能插入分隔线', () => {
    const { editor, open } = setup('before\n\nafter');
    const menu = open(7);
    const insert = menu.querySelector<HTMLButtonElement>('[data-submenu="insert"]');
    expect(insert).not.toBeNull(); expect(insert!.getAttribute('aria-disabled')).toBe('false');
    insert!.click();
    const rule = document.querySelector<HTMLButtonElement>('[data-markdown="horizontalRule"]')!;
    expect(rule.getAttribute('aria-disabled')).toBe('false'); rule.click();
    expect(editor.text).toBe('before\n\n---\n\nafter');
  });
  it('格式、剪贴板和历史横向分组，段落面板用键盘打开并返回', () => {
    const { open } = setup();
    const menu = open();
    expect(menu.querySelectorAll('.fm-format-row [data-markdown]')).toHaveLength(4);
    expect(menu.querySelectorAll('.fm-clipboard-row [data-command]')).toHaveLength(3);
    expect(menu.querySelectorAll('.fm-history-row [data-command]')).toHaveLength(2);
    const trigger = menu.querySelector<HTMLButtonElement>('[data-submenu="paragraph"]')!;
    trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    const panel = document.querySelector<HTMLElement>('.fm-markdown-submenu')!;
    expect(panel.getAttribute('role')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const heading = panel.querySelector<HTMLButtonElement>('[data-markdown="heading2"]')!;
    heading.focus(); heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(panel.querySelector('[data-markdown="heading1"]'));
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(document.querySelector('.fm-markdown-submenu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('格式工具行加粗选区，标题面板转换段落并支持撤销', () => {
    const { editor, open } = setup();
    editor.view.dispatch({ selection: { anchor: 0, head: 5 } });
    open(2).querySelector<HTMLButtonElement>('[data-markdown="bold"]')!.click();
    expect(editor.text).toBe('**alpha** beta');
    editor.undo(); expect(editor.text).toBe('alpha beta');
    const trigger = open(2).querySelector<HTMLButtonElement>('[data-submenu="paragraph"]')!;
    trigger.click();
    document.querySelector<HTMLButtonElement>('.fm-markdown-submenu [data-markdown="heading2"]')!.click();
    expect(editor.text).toBe('## alpha beta');
    editor.undo(); expect(editor.text).toBe('alpha beta');
  });
  it('主菜单焦点离开子菜单锚点或父面板滚动时关闭旧子菜单', () => {
    const { open } = setup();
    const menu = open();
    const trigger = menu.querySelector<HTMLButtonElement>('[data-submenu="paragraph"]')!;
    trigger.click(); trigger.focus();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(menu.querySelector('[data-submenu="insert"]'));
    expect(document.querySelector('.fm-markdown-submenu')).toBeNull();
    trigger.click(); menu.dispatchEvent(new Event('scroll'));
    expect(document.querySelector('.fm-markdown-submenu')).toBeNull();
  });
  it('焦点布局引起的正文自动滚动保留菜单，用户滚动正文关闭菜单', () => {
    const { editor, open } = setup(); open();
    editor.view.scrollDOM.dispatchEvent(new Event('scroll'));
    expect(document.querySelector('.fm-context-menu')).not.toBeNull();
    editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true }));
    expect(document.querySelector('.fm-context-menu')).toBeNull();
  });
  it('阻止默认菜单，在选区内保留选区，选区外按右键位置定位', () => {
    const { editor, open } = setup();
    editor.view.dispatch({ selection: { anchor: 1, head: 5 } });
    const selection = editor.state.selection;
    const menu = open(3);
    expect(menu.getAttribute('role')).toBe('menu');
    expect(editor.state.selection.eq(selection)).toBe(true);
    open(8);
    expect(editor.state.selection.main.head).toBe(8);
    expect(editor.state.selection.main.empty).toBe(true);
  });
  it('无选区时禁用剪切、复制和删除，键盘导航及 Escape 返回正文', () => {
    const { editor, open, action } = setup();
    const menu = open();
    expect(action('cut').getAttribute('aria-disabled')).toBe('true');
    expect(action('copy').getAttribute('aria-disabled')).toBe('true');
    expect(action('delete').getAttribute('aria-disabled')).toBe('true');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(action('selectAll'));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.fm-context-menu')).toBeNull();
    expect(editor.view.hasFocus).toBe(true);
  });
  it('Shift+F10 打开菜单，外部点击关闭且不抢外部焦点', () => {
    const { editor } = setup();
    editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.querySelector('.fm-context-menu')).not.toBeNull();
    const input = document.body.appendChild(document.createElement('input')); input.focus();
    input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('.fm-context-menu')).toBeNull();
    expect(document.activeElement).toBe(input);
  });
  it('剪切成功后提交可撤销删除，写剪贴板失败保留正文', async () => {
    const { editor, open, action, clipboard, status } = setup();
    editor.view.dispatch({ selection: { anchor: 0, head: 5 } }); open(2);
    action('cut').click(); await settled();
    expect(clipboard.writeText).toHaveBeenCalledWith('alpha');
    expect(editor.text).toBe(' beta');
    editor.undo(); expect(editor.text).toBe('alpha beta');
    vi.mocked(clipboard.writeText).mockRejectedValue(new Error('denied'));
    editor.view.dispatch({ selection: { anchor: 0, head: 5 } }); open(2);
    action('cut').click(); await settled();
    expect(editor.text).toBe('alpha beta'); expect(status).toHaveBeenCalled();
  });
  it('粘贴经过输入过滤且可一次撤销，读取失败不改正文', async () => {
    const { editor, open, action, clipboard, status } = setup();
    editor.view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.clipboardInputFilter.of(text => text.toUpperCase())) });
    editor.view.dispatch({ selection: { anchor: 0, head: 5 } }); open(2);
    action('paste').click(); await settled();
    expect(editor.text).toBe('PASTE beta');
    editor.undo(); expect(editor.text).toBe('alpha beta');
    vi.mocked(clipboard.readText).mockRejectedValue(new Error('denied'));
    open(2); action('paste').click(); await settled();
    expect(editor.text).toBe('alpha beta'); expect(status).toHaveBeenCalled();
  });
  it('多选区粘贴在文本行数匹配时按行分配，保持原生 Ctrl+V 语义', async () => {
    const { editor, open, action } = setup('alpha beta', 'todo', { readText: vi.fn().mockResolvedValue('one\ntwo'), writeText: vi.fn() });
    editor.view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(6, 10)]) });
    open(2); action('paste').click(); await settled();
    expect(editor.text).toBe('one two');
  });
  it('剪切等待期间切换项目取消删除，即使切回原状态也不能重新生效', async () => {
    let resolve!: () => void;
    const { editor, open, action } = setup('alpha beta', 'todo', { readText: vi.fn(), writeText: () => new Promise<void>(done => resolve = done) });
    editor.view.dispatch({ selection: { anchor: 0, head: 5 } });
    const previous = editor.state;
    open(2); action('cut').click();
    editor.restoreState(editor.createState('other', 'todo')); editor.restoreState(previous);
    resolve(); await settled(); expect(editor.text).toBe('alpha beta');
  });
  it('异步粘贴等待期间改变选区或项目后拒绝写入', async () => {
    let resolve!: (text: string) => void;
    const clipboard = { readText: () => new Promise<string>(done => resolve = done), writeText: vi.fn() };
    const { editor, open, action } = setup('alpha beta', 'todo', clipboard);
    open(2); action('paste').click();
    editor.view.dispatch({ selection: { anchor: 8 } }); resolve('stale'); await settled();
    expect(editor.text).toBe('alpha beta');
    open(2); action('paste').click();
    editor.restoreState(editor.createState('other project', 'todo')); resolve('stale'); await settled();
    expect(editor.text).toBe('other project');
  });
  it('焦点同步产生相同选区事务时不取消待提交的粘贴', async () => {
    let resolve!: (text: string) => void;
    const { editor, open, action } = setup('alpha beta', 'todo', { readText: () => new Promise<string>(done => resolve = done), writeText: vi.fn() });
    open(2); action('paste').click();
    editor.view.dispatch({ selection: editor.state.selection });
    resolve('new'); await settled(); expect(editor.text).toBe('alnewpha beta');
  });
  it('归档禁用自由编辑，仍可复制选区和使用控制器撤销', async () => {
    const { editor, open, action, clipboard } = setup('- [ ] task\n');
    editor.toggleTask(0); editor.setMode('archive');
    editor.view.dispatch({ selection: { anchor: 0, head: editor.text.length } }); open(editor.state.selection.main.from);
    for (const name of ['cut', 'paste', 'delete']) expect(action(name).getAttribute('aria-disabled')).toBe('true');
    expect(action('undo').getAttribute('aria-disabled')).toBe('false');
    action('copy').click(); await settled(); expect(clipboard.writeText).toHaveBeenCalled();
    open(); action('undo').click(); expect(editor.text).toBe('- [ ] task\n');
  });
  it('源码全选与剪切只处理可见分区，保留隐藏归档', async () => {
    const text = '- [ ] visible\n\n# 归档\n\n- [x] hidden\n';
    const { editor, open, action, clipboard } = setup(text);
    editor.toggleSource(); open(); action('selectAll').click();
    open(editor.state.selection.main.from); action('cut').click(); await settled();
    expect(clipboard.writeText).toHaveBeenCalledWith('- [ ] visible\n\n');
    expect(editor.text).toContain('# 归档\n\n- [x] hidden\n');
    expect(editor.text).not.toContain('visible');
  });
  it('销毁使待返回的剪切失效，正文不会删除', async () => {
    let resolve!: () => void;
    const { editor, open, action } = setup('alpha beta', 'todo', { readText: vi.fn(), writeText: () => new Promise<void>(done => resolve = done) });
    editor.view.dispatch({ selection: EditorSelection.range(0, 5) }); open(2); action('cut').click();
    editor.destroy(); instances.splice(instances.indexOf(editor), 1);
    resolve(); await settled(); expect(editor.text).toBe('alpha beta');
  });
});
