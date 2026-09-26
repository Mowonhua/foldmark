/**
 * 文件职责：管理列表标记手势及正文右侧、空任务、空段落的指针定位。
 * 定义范围：指针状态机、正文焦点、末尾空段落分隔和同列表可见插入边界。
 */
import { locale, translate } from '../i18n';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { getHiddenRanges } from '../markdown';
import { actionsFacet, documentField, modeFacet } from './state';
import { paragraphAt, paragraphLayout, replaceParagraphs } from './paragraphs';
import { hiddenContentRanges } from './visibility';

interface DragSession {
  from: number; pointerId: number; startX: number; startY: number; x: number; y: number;
  marker: HTMLElement; started: boolean; boundary: number | null | undefined;
  preview: HTMLElement | null; line: HTMLElement | null;
}

/** 指针压下不改变状态；超过阈值后禁止任何后续复选框单击，即使此次拖动取消。 */
class MarkerGestures {
  private session: DragSession | null = null;
  private paragraphAnchor: { position: number; x: number; y: number } | null = null;
  private frame = 0;
  private lastClick: { time: number; x: number; y: number; marker: HTMLElement } | null = null;
  private closeMenu: (() => void) | null = null;
  constructor(private readonly view: EditorView) {
    view.dom.addEventListener('pointerdown', this.down, true);
    view.scrollDOM.addEventListener('mousedown', this.forwardBottomMouseDown);
    view.dom.addEventListener('contextmenu', this.context, true);
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    window.addEventListener('pointercancel', this.cancel);
    window.addEventListener('keydown', this.key);
    window.addEventListener('blur', this.cancel);
  }
  update(update: ViewUpdate): void {
    if (update.docChanged) {
      const pending = this.paragraphAnchor;
      this.cancel(); this.closeMenu?.();
      if (pending) this.paragraphAnchor = { ...pending, position: update.changes.mapPos(pending.position) };
    }
    if (update.transactions.some(transaction => transaction.reconfigured)) this.paragraphAnchor = null;
  }
  /** 只供紧随本次 pointerdown 的 mousedown 消费；拖选建立后由选区样式持有并映射锚点。 */
  takeParagraphAnchor(event: MouseEvent): number | null {
    const pending = this.paragraphAnchor;
    this.paragraphAnchor = null;
    return pending && pending.x === event.clientX && pending.y === event.clientY ? pending.position : null;
  }
  /** 创建事务及焦点事务完成后才记录锚点，避免被同步 update 清除或重复映射。 */
  private prepareParagraphSelection(event: PointerEvent, position: number): void {
    this.view.state.facet(actionsFacet).focusAt(position);
    this.paragraphAnchor = { position: this.view.state.selection.main.head, x: event.clientX, y: event.clientY };
  }
  /** CodeMirror 只监听 contentDOM；滚动容器留白必须转交同一鼠标起点，才能接续原生拖选。 */
  private forwardBottomMouseDown = (event: MouseEvent): void => {
    const pending = this.paragraphAnchor;
    if (event.target !== this.view.scrollDOM || !pending || pending.x !== event.clientX || pending.y !== event.clientY) return;
    // 阻止原容器的默认选区覆盖转交结果；此时已进入 mousedown，不会截断后续鼠标移动。
    event.preventDefault();
    this.view.contentDOM.dispatchEvent(new MouseEvent('mousedown', event));
  };
  destroy(): void {
    this.cancel();
    this.closeMenu?.();
    this.view.dom.removeEventListener('pointerdown', this.down, true);
    this.view.scrollDOM.removeEventListener('mousedown', this.forwardBottomMouseDown);
    this.view.dom.removeEventListener('contextmenu', this.context, true);
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
    window.removeEventListener('pointercancel', this.cancel);
    window.removeEventListener('keydown', this.key);
    window.removeEventListener('blur', this.cancel);
  }
  private down = (event: PointerEvent): void => {
    this.paragraphAnchor = null;
    if (event.button !== 0) return;
    const marker = (event.target as Element).closest<HTMLElement>('[data-list-marker]');
    if (!marker) { this.focusEmptyContent(event); return; }
    if (!this.view.dom.contains(marker)) return;
    event.preventDefault();
    const from = Number(marker.dataset.listMarker);
    const recent = this.lastClick;
    // 收起完成项后，同一物理位置出现的是另一项；短时间重复按下不能误完成它。
    if (recent && recent.marker !== marker && performance.now() - recent.time < 360 && Math.hypot(event.clientX - recent.x, event.clientY - recent.y) < 5) return;
    this.cancel();
    this.session = { from: Number(marker.dataset.listMarker), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, marker, started: false, boundary: undefined, preview: null, line: null };
    marker.addEventListener('lostpointercapture', this.cancel);
    // 捕获保证拖出窗口后仍可收尾；无真实活动指针的测试事件允许回退到 window 监听。
    try { marker.setPointerCapture?.(event.pointerId); } catch { /* 浏览器拒绝非活动指针时，现有全局取消路径仍有效。 */ }
  };
  /**
   * 空任务和空段落没有可命中的正文字符，浏览器可能把右侧空白命中到后面的隐藏分隔。
   * 空段落在指针阶段准备编辑位置，再由 mousedown 接续拖选；任务控件列保留原有手势。
   * 每次从当前模型读取坐标，避免控件复用或任务移动后使用旧位置。
   */
  private focusEmptyContent(event: PointerEvent): void {
    if (this.view.state.readOnly || this.view.state.facet(modeFacet) !== 'todo'
      || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as Element;
    if (target.closest('button, a')) return;
    const line = target.closest('.cm-line');
    if (this.focusBelowContent(event, line)) return;
    if (!line || !this.view.contentDOM.contains(line)) return;
    const emptyFrom = line.getAttribute('data-empty-paragraph-from');
    if (emptyFrom !== null) {
      const layout = paragraphLayout(this.view.state);
      const index = paragraphAt(layout, Number(emptyFrom));
      const paragraph = layout.paragraphs[index];
      if (paragraph?.kind === 'empty') {
        this.cancel();
        // 单个尾换行可被无损解码为空段落，但尚无完整分隔；开始编辑时补齐，
        // 避免后续文字被 Markdown 并入前一任务。已有分隔及段内软换行不受影响。
        const previous = layout.paragraphs[index - 1];
        if (previous && paragraph.from === previous.to + 1) {
          const raw = this.view.state.doc.sliceString(paragraph.from, paragraph.to);
          this.view.dispatch(replaceParagraphs(this.view.state, index, index, [raw], paragraph.contentFrom - paragraph.from, 'input'));
          this.prepareParagraphSelection(event, this.view.state.selection.main.head);
          return;
        }
        this.prepareParagraphSelection(event, paragraph.contentFrom);
        return;
      }
    }
    const checkbox = line.querySelector<HTMLElement>('[role=checkbox][data-list-marker]');
    if (!checkbox || event.clientX < checkbox.getBoundingClientRect().right) return;
    const from = Number(checkbox.dataset.listMarker);
    const item = this.view.state.field(documentField).tasks.find(item => item.from === from);
    if (!item || item.contentFrom !== item.firstLineTo) return;
    event.preventDefault();
    this.cancel();
    this.view.state.facet(actionsFacet).focusAt(item.contentFrom);
  }

  /**
   * 视图底部可能是归档前的分隔行，而不是文件末尾；按可见段落确定编辑出口。
   * 只接管正文宽度内、最后可见段落下方的容器或空白行，重复点击复用已有空段落。
   */
  private focusBelowContent(event: PointerEvent, line: Element | null): boolean {
    const { state } = this.view, target = event.target as Element;
    if (line ? line.textContent?.trim() || line.querySelector('[data-list-marker]')
      : target !== this.view.contentDOM && target !== this.view.scrollDOM) return false;
    const layout = paragraphLayout(state), hidden = hiddenContentRanges(state);
    let index = layout.paragraphs.length - 1;
    while (index >= 0 && hidden.some(range => layout.paragraphs[index].from >= range.from
      && (layout.paragraphs[index].from < range.to || range.to === state.doc.length && layout.paragraphs[index].from === range.to))) index--;
    const paragraph = layout.paragraphs[index];
    // 字面块、软续行及仍有隐藏后代的条目继续使用各自的编辑契约。
    if (!paragraph || paragraph.kind === 'literal' || paragraph.item && paragraph.item.to > paragraph.to
      || layout.lineBreaks.some(br => br.to === paragraph.to)) return false;
    const bounds = this.view.coordsAtPos(paragraph.to);
    const content = this.view.contentDOM.getBoundingClientRect();
    if (!bounds || event.clientY < bounds.bottom || event.clientX < content.left || event.clientX > content.right) return false;
    const raw = state.doc.sliceString(paragraph.from, paragraph.to);
    // 新建采用空范围插入，仅维护末段之后的分隔，保留前面紧凑列表的原始间距。
    const spec = paragraph.kind === 'empty'
      ? replaceParagraphs(state, index, index, [raw], paragraph.contentFrom - paragraph.from, 'input')
      : replaceParagraphs(state, index + 1, index, [''], 0, 'input');
    // 序列化只允许维护可见边界，不能借底部点击改写归档或把光标放入隐藏内容。
    const planned = state.update({ ...spec, filter: false });
    let touchesHidden = false;
    planned.changes.iterChangedRanges((from, to) => {
      if (hidden.some(range => from < range.to && to > range.from)) touchesHidden = true;
    });
    if (touchesHidden || hiddenContentRanges(planned.state).some(range => planned.newSelection.main.head >= range.from && planned.newSelection.main.head < range.to)) return false;
    this.cancel();
    if (planned.docChanged) this.view.dispatch(spec);
    this.prepareParagraphSelection(event, planned.docChanged ? this.view.state.selection.main.head : planned.newSelection.main.head);
    return true;
  }
  private move = (event: PointerEvent): void => {
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    if (event.isTrusted && event.buttons === 0) { this.cancel(); return; }
    session.x = event.clientX; session.y = event.clientY;
    if (!session.started && Math.hypot(session.x - session.startX, session.y - session.startY) > 6) {
      session.started = true;
      // 归档允许复选框恢复，任何移动仍取消单击，但只在待办模式创建排序会话。
      if (this.view.state.facet(modeFacet) !== 'todo') return;
      session.preview = document.createElement('div'); session.preview.className = 'fm-drag-preview';
      const item = this.view.state.field(documentField).items.find(item => item.from === session.from);
      session.preview.textContent = item ? this.view.state.doc.sliceString(item.contentFrom, item.firstLineTo) || translate('空列表项') : '';
      session.line = document.createElement('div'); session.line.className = 'fm-drop-line';
      document.body.append(session.preview, session.line);
      document.body.classList.add('fm-dragging');
      this.frame = requestAnimationFrame(this.scroll);
    }
    if (session.started) { event.preventDefault(); this.locate(); }
  };
  private locate(): void {
    const session = this.session;
    if (!session?.preview || !session.line) return;
    session.preview.style.left = `${session.x + 14}px`; session.preview.style.top = `${session.y + 10}px`;
    session.boundary = undefined; session.line.hidden = true;
    const rect = this.view.scrollDOM.getBoundingClientRect();
    if (session.x < rect.left || session.x > rect.right || session.y < rect.top || session.y > rect.bottom) return;
    const model = this.view.state.field(documentField);
    const source = model.items.find(item => item.from === session.from);
    if (!source) return;
    const hidden = getHiddenRanges(model, 'todo');
    const siblings = model.items.filter(item => item.listFrom === source.listFrom && item.parentFrom === source.parentFrom);
    const visible = siblings.filter(item => !hidden.some(range => item.from >= range.from && item.from < range.to));
    const boundaries: { before: number | null; y: number }[] = [];
    for (const item of visible) {
      const coords = this.view.coordsAtPos(item.from);
      if (coords) boundaries.push({ before: item.from, y: coords.top - 2 });
    }
    const last = visible.at(-1);
    if (last) {
      const coords = this.view.coordsAtPos(last.to);
      const next = siblings[siblings.indexOf(last) + 1];
      if (coords) boundaries.push({ before: next?.from ?? null, y: coords.bottom + 2 });
    }
    const nearest = boundaries.sort((a, b) => Math.abs(a.y - session.y) - Math.abs(b.y - session.y))[0];
    if (!nearest || Math.abs(nearest.y - session.y) > 30 || nearest.before === source.from) return;
    session.boundary = nearest.before;
    session.line.hidden = false; session.line.style.top = `${nearest.y}px`;
    session.line.style.left = `${Math.max(rect.left + 24, this.view.contentDOM.getBoundingClientRect().left)}px`;
    session.line.style.width = `${Math.min(rect.width - 48, this.view.contentDOM.getBoundingClientRect().width)}px`;
  }
  private scroll = (): void => {
    const session = this.session;
    if (!session?.preview) return;
    const rect = this.view.scrollDOM.getBoundingClientRect();
    const delta = session.y < rect.top + 48 ? -Math.min(18, (rect.top + 48 - session.y) / 3) : session.y > rect.bottom - 48 ? Math.min(18, (session.y - rect.bottom + 48) / 3) : 0;
    if (delta) { this.view.scrollDOM.scrollTop += delta; this.locate(); }
    this.frame = requestAnimationFrame(this.scroll);
  };
  private up = (event: PointerEvent): void => {
    this.paragraphAnchor = null;
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    const actions = this.view.state.facet(actionsFacet);
    const markerRect = session.marker.getBoundingClientRect();
    const click = !session.started && event.clientX >= markerRect.left && event.clientX <= markerRect.right && event.clientY >= markerRect.top && event.clientY <= markerRect.bottom;
    const boundary = session.boundary;
    this.cancel();
    if (session.started && boundary !== undefined) actions.moveTo(session.from, boundary);
    if (click && session.marker.getAttribute('role') === 'checkbox') {
      this.lastClick = { time: performance.now(), x: event.clientX, y: event.clientY, marker: session.marker };
      actions.toggleTask(session.from);
    }
  };
  private key = (event: KeyboardEvent): void => { this.paragraphAnchor = null; if (event.key === 'Escape' && this.session) { event.preventDefault(); this.cancel(); } };
  private cancel = (): void => {
    this.paragraphAnchor = null;
    cancelAnimationFrame(this.frame);
    const session = this.session;
    this.session = null;
    session?.preview?.remove(); session?.line?.remove();
    if (session) {
      session.marker.removeEventListener('lostpointercapture', this.cancel);
      try { if (session.marker.hasPointerCapture?.(session.pointerId)) session.marker.releasePointerCapture(session.pointerId); } catch { /* 控件被事务移除时捕获可能已由浏览器释放。 */ }
    }
    document.body.classList.remove('fm-dragging');
  };
  private context = (event: MouseEvent): void => {
    const marker = (event.target as Element).closest<HTMLElement>('[data-list-marker]');
    if (!marker) return;
    event.preventDefault();
    this.closeMenu?.();
    const from = Number(marker.dataset.listMarker);
    const actions = this.view.state.facet(actionsFacet);
    const menu = document.createElement('div'); menu.className = 'fm-item-menu'; menu.setAttribute('role', 'menu');
    menu.style.left = `${event.clientX}px`; menu.style.top = `${event.clientY}px`;
    const entries: [string, () => void][] = [['折叠 / 展开', () => actions.toggleFold(from)]];
    if (this.view.state.facet(modeFacet) === 'todo') entries.push(['上移', () => actions.moveItem(from, 'up')], ['下移', () => actions.moveItem(from, 'down')]);
    const item = this.view.state.field(documentField).items.find(item => item.from === from);
    if (item?.task) entries.push([item.task.checked ? '恢复任务' : '完成整组', () => actions.toggleTask(from, !item.task?.checked)]);
    if (item?.task?.checked && this.view.state.field(documentField).tasks.some(child => child.from > item.from && child.to <= item.to && !child.task?.checked)) entries.push(['完成整组', () => actions.toggleTask(from, true)]);
    const close = (): void => { unsubscribe(); menu.remove(); window.removeEventListener('pointerdown', outside, true); this.closeMenu = null; };
    const outside = (event: Event): void => { if (!menu.contains(event.target as Node)) close(); };
    this.closeMenu = close;
    for (const [label, action] of entries) { const button = document.createElement('button'); button.textContent = translate(label); button.setAttribute('role', 'menuitem'); button.onclick = () => { close(); action(); }; menu.append(button); }
    // 浮层不属于编辑器装饰，由本次菜单订阅负责刷新并在关闭时释放。
    const unsubscribe = locale.subscribe(() => entries.forEach(([label], index) => { menu.children[index].textContent = translate(label); }));
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { close(); marker.focus(); } });
    document.body.append(menu); (menu.firstElementChild as HTMLElement).focus();
    window.addEventListener('pointerdown', outside, true);
  };
}

/** 只校正普通正文末排的右侧空白；折行前排和字内位置继续使用原生坐标命中。 */
function textLineEnd(view: EditorView, target: EventTarget | null, event: MouseEvent): number | null {
  if (!(target instanceof Element) || !target.matches('.cm-line') || !view.contentDOM.contains(target)) return null;
  const sourceLine = view.state.doc.lineAt(view.posAtDOM(target, 0));
  const layout = paragraphLayout(view.state);
  const paragraph = layout.paragraphs[paragraphAt(layout, sourceLine.from)];
  if (paragraph?.kind !== 'text' || paragraph.item) return null;
  const end = view.coordsAtPos(sourceLine.to, -1);
  return end && event.clientX > end.right && event.clientY >= end.top && event.clientY < end.bottom ? sourceLine.to : null;
}

/**
 * 右侧空白可能命中隐藏分隔；在鼠标选区流程内纠正起点，不能阻止 pointerdown，
 * 否则浏览器不会继续发送建立拖选所需的 mousedown。移动、滚动和释放仍由 CodeMirror 管理。
 */
const paragraphMouseSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  const prepared = view.plugin(markerGestures)?.takeParagraphAnchor(event) ?? null;
  if (event.button !== 0 || event.detail !== 1 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
    || view.state.readOnly || view.state.facet(modeFacet) !== 'todo') return null;
  const end = prepared ?? textLineEnd(view, event.target, event);
  if (end === null) return null;
  let anchor = end, startSelection = view.state.selection;
  return {
    get(current, extend, multiple) {
      // 拖动和自动滚动时事件 target 可能停留在旧节点，终点必须按当前坐标重新命中。
      const corrected = current === event ? anchor
        : textLineEnd(view, view.root.elementFromPoint?.(current.clientX, current.clientY) ?? null, current);
      const hit = corrected === null ? view.posAndSideAtCoords({ x: current.clientX, y: current.clientY }, false)
        : { pos: corrected, assoc: -1 };
      const range = EditorSelection.range(anchor, hit.pos, hit.assoc);
      if (extend) return startSelection.replaceRange(startSelection.main.extend(hit.pos, hit.pos, hit.assoc));
      return multiple ? startSelection.addRange(range) : EditorSelection.create([range]);
    },
    update(update) {
      if (!update.docChanged) return;
      anchor = update.changes.mapPos(anchor);
      startSelection = startSelection.map(update.changes);
    },
  };
});

export const markerGestures = ViewPlugin.fromClass(MarkerGestures, { provide: () => paragraphMouseSelection });
