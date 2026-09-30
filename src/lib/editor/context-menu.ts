/**
 * 文件职责：承载正文右键菜单及其编辑意图，复用 CodeMirror 事务与剪贴板过滤契约。
 * 定义范围：菜单生命周期、选区定位、编辑操作和异步意图失效保护。
 */
import { EditorSelection, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory, redoDepth, selectAll, undoDepth } from '@codemirror/commands';
import type { ClipboardPort } from '../clipboard';
import { translate } from '../i18n';
import { modeFacet, sourceViewFacet } from './state';
import { sourceVisibleRanges } from './source-scope';
import { markdownActionActive, markdownActionEnabled, runMarkdownAction, type MarkdownAction } from './markdown-actions';
import { markerGestures } from './gestures';

/**
 * 结构职责：记录正文菜单的二级面板及其返回锚点。
 * 字段说明：trigger 属于主菜单；panel 进入顶层，不受主菜单滚动裁切。
 * 约束条件：同一时间仅打开一个面板，主菜单关闭时一起释放。
 */
interface Submenu { trigger: HTMLButtonElement; panel: HTMLDivElement }
/** 菜单元数据仅描述动作入口；语法可用性、活动态与写入契约由共享 Markdown 命令决定。 */
interface MarkdownEntry { action: MarkdownAction; label: string; glyph?: string }
const inlineEntries: readonly MarkdownEntry[] = [
  { action: 'bold', label: '粗体', glyph: 'B' }, { action: 'italic', label: '斜体', glyph: 'I' },
  { action: 'strike', label: '删除线', glyph: 'S' }, { action: 'inlineCode', label: '行内代码', glyph: '</>' },
];
const paragraphEntries: readonly MarkdownEntry[] = [
  { action: 'paragraph', label: '普通段落' },
  ...Array.from({ length: 6 }, (_, index): MarkdownEntry => ({ action: `heading${index + 1}` as MarkdownAction, label: `标题 ${index + 1}`, glyph: `H${index + 1}` })),
  { action: 'quote', label: '引用' }, { action: 'bulletList', label: '无序列表' },
  { action: 'orderedList', label: '有序列表' }, { action: 'taskList', label: '任务列表' },
];
const insertEntries: readonly MarkdownEntry[] = [
  { action: 'link', label: '插入链接' }, { action: 'codeBlock', label: '代码块' },
  { action: 'mathBlock', label: '公式块' }, { action: 'horizontalRule', label: '分隔线' },
];

/** 菜单只提供正文编辑动作；模式切换和项目操作继续由应用管理。 */
type MenuCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll';
interface MenuEntry { command: MenuCommand; label: string; shortcut?: string; enabled: boolean }

// ==================== 接口和抽象契约 ====================
/**
 * 接口职责：注入正文菜单需要的历史与反馈能力。
 * 调用方：唯一 EditorController。
 * 实现要求：历史命令保留归档的受控撤销能力，剪贴板失败通过状态端口反馈。
 */
export interface ContextMenuOptions {
  clipboard: ClipboardPort;
  undo: () => boolean;
  redo: () => boolean;
  onStatus?: (message: string) => void;
}

// ==================== 函数和方法定义 ====================
/**
 * 接口职责：管理一个编辑视图的正文菜单与异步剪贴板意图。
 * 调用方：EditorController 生命周期及更新监听器。
 * 实现要求：关闭时不抢外部焦点；状态替换与卸载必须使待提交剪切、粘贴失效。
 */
export class EditorContextMenu {
  private popup: HTMLDivElement | null = null;
  private submenu: Submenu | null = null;
  private generation = 0;
  private disposed = false;
  constructor(private readonly view: EditorView, private readonly options: ContextMenuOptions) {
    view.dom.addEventListener('mousedown', this.rightMouseDown, true);
    view.dom.addEventListener('contextmenu', this.context, true);
    view.dom.addEventListener('keydown', this.openKey, true);
    document.addEventListener('pointerdown', this.outsidePointer, true);
    document.addEventListener('focusin', this.outsideFocus);
    document.addEventListener('scroll', this.scroll, true);
    document.addEventListener('wheel', this.wheel, { capture: true, passive: true });
    window.addEventListener('resize', this.invalidate);
    window.addEventListener('blur', this.invalidate);
    window.visualViewport?.addEventListener('resize', this.invalidate);
    window.visualViewport?.addEventListener('scroll', this.invalidate);
  }
  /**
   * 函数职责：关闭菜单并取消尚未提交的剪贴板编辑意图。
   * 输入说明：由项目、正文、模式或选区变化及销毁路径调用。
   * 输出说明：仅移除浮层和监听，不修改正文或外部焦点。
   * 实现思路：递增意图代数，清理菜单专属事件。
   */
  invalidate = (): void => { this.generation++; this.close(); };
  /**
   * 函数职责：释放正文菜单拥有的事件和浮层。
   * 输入说明：控制器销毁时调用一次。
   * 输出说明：异步返回不得再访问已卸载的视图。
   * 实现思路：先取消意图，再解绑编辑视图上的入口事件。
   */
  destroy(): void {
    this.disposed = true; this.invalidate();
    this.view.dom.removeEventListener('mousedown', this.rightMouseDown, true);
    this.view.dom.removeEventListener('contextmenu', this.context, true);
    this.view.dom.removeEventListener('keydown', this.openKey, true);
    document.removeEventListener('pointerdown', this.outsidePointer, true);
    document.removeEventListener('focusin', this.outsideFocus);
    document.removeEventListener('scroll', this.scroll, true);
    document.removeEventListener('wheel', this.wheel, true);
    window.removeEventListener('resize', this.invalidate);
    window.removeEventListener('blur', this.invalidate);
    window.visualViewport?.removeEventListener('resize', this.invalidate);
    window.visualViewport?.removeEventListener('scroll', this.invalidate);
  }

  /** 列表标记有独立结构菜单；代码语言输入框保留平台文本输入菜单。 */
  private ownsTarget(target: EventTarget | null): boolean {
    return target instanceof Element && this.view.dom.contains(target)
      && !target.closest('input, textarea, select, [data-list-marker]');
  }
  private rightMouseDown = (event: MouseEvent): void => {
    // 在浏览器更新原生选区之前接管右键，选区内点击才能保留完整选区。
    if (event.button === 2 && this.ownsTarget(event.target)) event.preventDefault();
  };
  private context = (event: MouseEvent): void => {
    if (event.defaultPrevented || !this.ownsTarget(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    this.reveal(keyboard ? null : { x: event.clientX, y: event.clientY }, event);
  };
  private openKey = (event: KeyboardEvent): void => {
    if (event.isComposing || !this.ownsTarget(event.target)
      || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault(); event.stopPropagation(); this.reveal(null);
  };
  private outsidePointer = (event: Event): void => {
    if (!this.containsMenu(event.target)) this.invalidate();
  };
  private outsideFocus = (event: FocusEvent): void => {
    if (!this.containsMenu(event.target) && !this.view.dom.contains(event.target as Node)) this.invalidate();
  };
  private scroll = (event: Event): void => {
    if (event.target === this.popup) { this.closeSubmenu(); return; }
    // 焦点切换会重新绘制 Markdown 并引起正文滚动锚定；这不是用户离开上下文的操作。
    // 正文的滚轮、触摸或滚动条交互分别由 wheel / pointerdown 关闭菜单。
    if (this.popup && event.target !== this.view.scrollDOM && !this.containsMenu(event.target)) this.invalidate();
  };
  private wheel = (event: WheelEvent): void => {
    if (this.popup && !this.containsMenu(event.target)) this.invalidate();
  };
  private containsMenu(target: EventTarget | null): boolean {
    return target instanceof Node && !!(this.popup?.contains(target) || this.submenu?.panel.contains(target));
  }
  private close(): void {
    this.closeSubmenu();
    this.popup?.remove(); this.popup = null;
  }
  private closeSubmenu(): void {
    this.submenu?.trigger.setAttribute('aria-expanded', 'false');
    this.submenu?.panel.remove(); this.submenu = null;
  }

  /**
   * 函数职责：展示依赖当前语法上下文的 Markdown 二级动作。
   * 输入说明：trigger 为主菜单项，group 决定段落转换或结构插入动作。
   * 输出说明：不修改正文，键盘右键打开时移入面板，左键或 Escape 返回锚点。
   * 实现思路：复用主题浮层，按窗口剩余空间向右或左展开并钳位。
   */
  private openSubmenu(trigger: HTMLButtonElement, group: 'paragraph' | 'insert', focus: boolean): void {
    if (trigger.getAttribute('aria-disabled') === 'true') return;
    if (this.submenu?.trigger === trigger) {
      if (focus) this.submenu.panel.querySelector<HTMLButtonElement>('button')?.focus();
      return;
    }
    this.closeSubmenu();
    const panel = document.createElement('div');
    panel.className = 'dropdown fm-context-menu fm-markdown-submenu';
    panel.setAttribute('role', 'menu'); panel.setAttribute('popover', 'manual');
    panel.setAttribute('aria-label', translate(group === 'paragraph' ? '段落' : '插入'));
    const entries = group === 'paragraph' ? paragraphEntries : insertEntries;
    if (group === 'paragraph') {
      panel.append(this.markdownButton(entries[0]));
      const headings = document.createElement('div'); headings.className = 'fm-menu-grid fm-heading-grid';
      headings.setAttribute('role', 'group'); headings.setAttribute('aria-label', translate('标题'));
      for (const entry of entries.slice(1, 7)) headings.append(this.markdownButton(entry));
      panel.append(headings); this.separator(panel);
      for (const entry of entries.slice(7)) panel.append(this.markdownButton(entry));
    } else {
      for (const entry of entries) panel.append(this.markdownButton(entry));
    }
    panel.onkeydown = this.menuKey; panel.oncontextmenu = event => event.preventDefault();
    this.submenu = { trigger, panel }; trigger.setAttribute('aria-expanded', 'true');
    document.body.append(panel); panel.showPopover?.();
    const bounds = trigger.getBoundingClientRect(), edge = this.popup!.getBoundingClientRect();
    this.positionMenu(panel, edge.right + 4, bounds.top, edge);
    if (focus) (panel.querySelector<HTMLButtonElement>('[aria-disabled="false"]') ?? panel.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true });
  }

  /** 所有格式动作执行前重新校验；面板移走焦点不改变 CodeMirror 选区。 */
  private markdownButton(entry: MarkdownEntry): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button'; button.tabIndex = -1; button.dataset.markdown = entry.action;
    button.setAttribute('role', 'menuitemcheckbox');
    button.setAttribute('aria-label', translate(entry.label)); button.title = translate(entry.label);
    button.setAttribute('aria-checked', String(markdownActionActive(this.view.state, entry.action)));
    button.setAttribute('aria-disabled', String(!markdownActionEnabled(this.view, entry.action)));
    if (entry.glyph) { button.textContent = entry.glyph; button.className = `fm-format-${entry.action}`; }
    else {
      const label = document.createElement('span'); label.textContent = translate(entry.label);
      const check = document.createElement('span'); check.className = 'fm-menu-check'; check.setAttribute('aria-hidden', 'true');
      if (markdownActionActive(this.view.state, entry.action)) check.textContent = '✓';
      button.append(label, check);
    }
    button.onpointermove = () => button.focus({ preventScroll: true });
    button.onclick = () => {
      if (!markdownActionEnabled(this.view, entry.action)) return;
      this.close(); this.view.focus(); runMarkdownAction(this.view, entry.action);
    };
    return button;
  }

  private separator(parent: HTMLElement): void {
    const separator = document.createElement('hr'); separator.setAttribute('role', 'separator'); parent.append(separator);
  }

  private editButton(entry: MenuEntry, compact = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button'; button.tabIndex = -1; button.dataset.command = entry.command;
    button.setAttribute('role', 'menuitem'); button.setAttribute('aria-label', translate(entry.label));
    // 禁用项可接收焦点，辅助技术仍能发现操作；激活时再次校验，禁止修改正文。
    button.setAttribute('aria-disabled', String(!entry.enabled));
    button.title = `${translate(entry.label)}${entry.shortcut ? ` (${entry.shortcut})` : ''}`;
    const label = document.createElement('span'); label.textContent = translate(entry.label); button.append(label);
    if (entry.shortcut && !compact) { const key = document.createElement('kbd'); key.textContent = entry.shortcut; key.setAttribute('aria-hidden', 'true'); button.append(key); }
    button.onpointermove = () => { this.closeSubmenu(); button.focus({ preventScroll: true }); };
    button.onclick = () => { void this.execute(entry.command); };
    return button;
  }

  private submenuTrigger(group: 'paragraph' | 'insert'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button'; button.tabIndex = -1; button.dataset.submenu = group;
    button.setAttribute('role', 'menuitem'); button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
    const entries = group === 'paragraph' ? paragraphEntries : insertEntries;
    button.setAttribute('aria-disabled', String(!entries.some(entry => markdownActionEnabled(this.view, entry.action))));
    const label = document.createElement('span'); label.textContent = translate(group === 'paragraph' ? '段落' : '插入');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('viewBox', '0 0 16 16'); arrow.setAttribute('width', '16'); arrow.setAttribute('height', '16'); arrow.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(arrow.namespaceURI, 'path');
    path.setAttribute('d', 'm6 4 4 4-4 4'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5');
    arrow.append(path); button.append(label, arrow);
    button.onpointerenter = () => this.openSubmenu(button, group, false);
    button.onpointermove = () => button.focus({ preventScroll: true });
    button.onclick = () => this.openSubmenu(button, group, true);
    return button;
  }

  private entries(): MenuEntry[] {
    const { state } = this.view;
    const selected = state.selection.ranges.some(range => !range.empty);
    const writable = !state.readOnly && !this.view.composing;
    const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
    return [
      { command: 'undo', label: '撤销', shortcut: `${modifier} Z`, enabled: undoDepth(state) > 0 && !this.view.composing },
      { command: 'redo', label: '重做', shortcut: `${modifier} Shift Z`, enabled: redoDepth(state) > 0 && !this.view.composing },
      { command: 'cut', label: '剪切', shortcut: `${modifier} X`, enabled: writable && selected },
      { command: 'copy', label: '复制', shortcut: `${modifier} C`, enabled: selected },
      { command: 'paste', label: '粘贴', shortcut: `${modifier} V`, enabled: writable },
      { command: 'delete', label: '删除', enabled: writable && selected },
      { command: 'selectAll', label: '全选', shortcut: `${modifier} A`, enabled: state.doc.length > 0 },
    ];
  }

  /** 鼠标菜单锚定点击处，键盘菜单锚定当前选区；顶层浮层避免正文容器裁切。 */
  private reveal(point: { x: number; y: number } | null, event?: MouseEvent): void {
    this.invalidate();
    if (point) {
      const geometricPosition = this.view.posAtCoords(point, false);
      // 空段落及底部留白的源文身份由已有指针定位端口决定，不能使用几何近邻覆盖它。
      const position = event ? this.view.plugin(markerGestures)?.contextPosition(event, geometricPosition) ?? geometricPosition : geometricPosition;
      if (position !== null && !this.view.state.selection.ranges.some(range => !range.empty && position >= range.from && position <= range.to)) {
        this.view.dispatch({ selection: { anchor: position }, userEvent: 'select.pointer' });
      }
    }
    this.view.focus();
    const caret = point ? null : this.view.coordsAtPos(this.view.state.selection.main.head);
    const bounds = this.view.dom.getBoundingClientRect();
    const x = point?.x ?? caret?.left ?? bounds.left;
    const y = point?.y ?? caret?.bottom ?? bounds.top;
    const menu = document.createElement('div');
    menu.className = 'dropdown fm-context-menu'; menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', translate('正文编辑')); menu.setAttribute('popover', 'manual');
    // 常用行内格式与编辑动作紧凑横排，结构能力按语义分入二级面板。
    // 只读或字面块省略无可用 Markdown 能力的区域，不将无关操作铺满菜单。
    if (inlineEntries.some(entry => markdownActionEnabled(this.view, entry.action))
      || [...paragraphEntries, ...insertEntries].some(entry => markdownActionEnabled(this.view, entry.action))) {
      const formats = document.createElement('div'); formats.className = 'fm-menu-grid fm-format-row';
      formats.setAttribute('role', 'group'); formats.setAttribute('aria-label', translate('文本格式'));
      for (const entry of inlineEntries) formats.append(this.markdownButton(entry));
      menu.append(formats); this.separator(menu);
      menu.append(this.submenuTrigger('paragraph'), this.submenuTrigger('insert')); this.separator(menu);
    }
    const entries = this.entries();
    const clipboardRow = document.createElement('div'); clipboardRow.className = 'fm-menu-grid fm-clipboard-row';
    clipboardRow.setAttribute('role', 'group'); clipboardRow.setAttribute('aria-label', translate('剪贴板'));
    for (const entry of entries.slice(2, 5)) clipboardRow.append(this.editButton(entry, true));
    const historyRow = document.createElement('div'); historyRow.className = 'fm-menu-grid fm-history-row';
    historyRow.setAttribute('role', 'group'); historyRow.setAttribute('aria-label', translate('编辑历史'));
    for (const entry of entries.slice(0, 2)) historyRow.append(this.editButton(entry, true));
    menu.append(clipboardRow, historyRow); this.separator(menu);
    for (const entry of entries.slice(5)) menu.append(this.editButton(entry));
    menu.onkeydown = this.menuKey;
    menu.addEventListener('focusin', event => {
      if (this.submenu && event.target !== this.submenu.trigger) this.closeSubmenu();
    });
    menu.oncontextmenu = event => event.preventDefault();
    this.popup = menu; document.body.append(menu);
    menu.showPopover?.();
    this.positionMenu(menu, x, y);
    (menu.querySelector<HTMLElement>('[aria-disabled="false"]') ?? menu.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }

  private positionMenu(menu: HTMLElement, x: number, y: number, trigger?: DOMRect): void {
    // 尺寸必须在浮层显示后测量；小窗口允许菜单内部滚动，四边保留安全间距。
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
    menu.style.maxWidth = `${Math.max(0, width - 16)}px`;
    menu.style.maxHeight = `${Math.max(0, height - 16)}px`;
    const size = menu.getBoundingClientRect();
    // 二级面板优先向右展开，右侧不足则翻到左侧；窄窗口最后统一钳位。
    if (trigger && x + size.width > left + width - 8) x = trigger.left - size.width - 4;
    menu.style.left = `${Math.max(left + 8, Math.min(x, left + width - size.width - 8))}px`;
    menu.style.top = `${Math.max(top + 8, Math.min(y, top + height - size.height - 8))}px`;
  }

  private menuKey = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    const panel = event.currentTarget as HTMLElement;
    const active = document.activeElement as HTMLButtonElement;
    const grid = active?.parentElement?.classList.contains('fm-menu-grid') ? active.parentElement : null;
    const canMoveLeft = grid && [...grid.querySelectorAll('button')].indexOf(active) > 0;
    // 标题网格内的左键先移动到前一项；网格起点或普通二级菜单项才返回主菜单。
    if (this.submenu && panel === this.submenu.panel && (event.key === 'Escape' || event.key === 'ArrowLeft' && !canMoveLeft)) {
      event.preventDefault(); event.stopPropagation();
      const trigger = this.submenu.trigger; this.closeSubmenu(); trigger.focus({ preventScroll: true }); return;
    }
    if (event.key === 'ArrowRight' && active?.dataset.submenu) {
      event.preventDefault(); event.stopPropagation(); this.openSubmenu(active, active.dataset.submenu as 'paragraph' | 'insert', true); return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      event.stopPropagation(); this.invalidate(); this.view.focus(); return;
    }
    if (['ArrowLeft', 'ArrowRight'].includes(event.key) && active?.parentElement?.classList.contains('fm-menu-grid')) {
      event.preventDefault(); event.stopPropagation();
      const siblings = [...active.parentElement.querySelectorAll<HTMLButtonElement>('button')];
      const next = (siblings.indexOf(active) + (event.key === 'ArrowRight' ? 1 : -1) + siblings.length) % siblings.length;
      siblings[next]?.focus(); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button')];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  };

  /** 等待剪贴板期间允许焦点事务；正文、选区、模式或生命周期变化后取消旧编辑意图。 */
  private currentIntent(state: EditorState, generation: number): boolean {
    const current = this.view.state;
    return !this.disposed && generation === this.generation && current.doc === state.doc
      && current.selection.eq(state.selection) && current.readOnly === state.readOnly
      && current.facet(modeFacet) === state.facet(modeFacet) && current.facet(sourceViewFacet) === state.facet(sourceViewFacet)
      && !this.view.composing;
  }

  private async execute(command: MenuCommand): Promise<void> {
    if (!this.entries().find(entry => entry.command === command)?.enabled) return;
    this.close(); this.view.focus();
    const state = this.view.state, generation = ++this.generation;
    try {
      if (command === 'undo' || command === 'redo') { this.options[command](); return; }
      if (command === 'selectAll') {
        if (state.facet(modeFacet) !== 'source') { selectAll(this.view); return; }
        const ranges = sourceVisibleRanges(state);
        if (ranges.length) this.view.dispatch({ selection: EditorSelection.create(ranges.map(range => EditorSelection.range(range.from, range.to))), userEvent: 'select' });
        return;
      }
      if (command === 'paste') {
        let text = await this.options.clipboard.readText();
        if (!this.currentIntent(state, generation) || !text) return;
        for (const filter of state.facet(EditorView.clipboardInputFilter)) text = filter(text, state);
        const content = state.toText(text);
        let line = 1;
        // 与 CodeMirror 原生粘贴保持一致：行数等于选区数时逐行分配，否则每个选区插入全文。
        const changes = content.lines === state.selection.ranges.length ? state.changeByRange(range => {
          const insert = content.line(line++).text;
          return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
        }) : state.replaceSelection(content);
        this.view.dispatch({ ...changes, userEvent: 'input.paste', annotations: isolateHistory.of('full'), scrollIntoView: true });
        return;
      }
      if (command === 'copy' || command === 'cut') {
        let text = state.selection.ranges.filter(range => !range.empty).map(range => state.sliceDoc(range.from, range.to)).join(state.lineBreak);
        for (const filter of state.facet(EditorView.clipboardOutputFilter)) text = filter(text, state);
        // 写入成功之前不删除正文；失败或目标已变化时保留原文。
        await this.options.clipboard.writeText(text);
        if (command === 'copy' || !this.currentIntent(state, generation)) return;
      }
      // 源码写保护和隐藏分区过滤仍经过普通事务管线，禁止 bypass filter。
      this.view.dispatch({ ...state.replaceSelection(''), userEvent: command === 'cut' ? 'delete.cut' : 'delete.selection', annotations: isolateHistory.of('full'), scrollIntoView: true });
    } catch {
      if (this.currentIntent(state, generation)) this.options.onStatus?.(translate(command === 'paste' ? '无法读取剪贴板' : '无法写入剪贴板'));
    }
  }
}
