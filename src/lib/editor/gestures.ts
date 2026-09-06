/**
 * 文件职责：管理列表原标记上的单击、拖动、取消与自动滚动。
 * 定义范围：指针状态机和同列表可见插入边界，不直接修改正文。
 */
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { getHiddenRanges } from '../markdown';
import { actionsFacet, completionField, documentField, modeFacet } from './state';

interface DragSession {
  from: number; pointerId: number; startX: number; startY: number; x: number; y: number;
  marker: HTMLElement; started: boolean; boundary: number | null | undefined;
  preview: HTMLElement | null; line: HTMLElement | null;
}

/** 指针压下不改变状态；超过阈值后禁止任何后续复选框单击，即使此次拖动取消。 */
class MarkerGestures {
  private session: DragSession | null = null;
  private frame = 0;
  private lastClick: { time: number; x: number; y: number; marker: HTMLElement } | null = null;
  constructor(private readonly view: EditorView) {
    view.dom.addEventListener('pointerdown', this.down, true);
    view.dom.addEventListener('contextmenu', this.context, true);
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    window.addEventListener('pointercancel', this.cancel);
    window.addEventListener('keydown', this.key);
    window.addEventListener('blur', this.cancel);
  }
  update(update: ViewUpdate): void { if (update.docChanged) this.cancel(); }
  destroy(): void {
    this.cancel();
    this.view.dom.removeEventListener('pointerdown', this.down, true);
    this.view.dom.removeEventListener('contextmenu', this.context, true);
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
    window.removeEventListener('pointercancel', this.cancel);
    window.removeEventListener('keydown', this.key);
    window.removeEventListener('blur', this.cancel);
  }
  private down = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const marker = (event.target as Element).closest<HTMLElement>('[data-list-marker]');
    if (!marker || !this.view.dom.contains(marker)) return;
    event.preventDefault();
    const from = Number(marker.dataset.listMarker);
    if ([...this.view.state.field(completionField).values()].includes(from)) return;
    const recent = this.lastClick;
    // 收起完成项后，同一物理位置出现的是另一项；短时间重复按下不能误完成它。
    if (recent && recent.marker !== marker && performance.now() - recent.time < 360 && Math.hypot(event.clientX - recent.x, event.clientY - recent.y) < 5) return;
    this.cancel();
    this.session = { from: Number(marker.dataset.listMarker), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, marker, started: false, boundary: undefined, preview: null, line: null };
  };
  private move = (event: PointerEvent): void => {
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    session.x = event.clientX; session.y = event.clientY;
    if (!session.started && Math.hypot(session.x - session.startX, session.y - session.startY) > 6) {
      session.started = true;
      // 归档允许复选框恢复，任何移动仍取消单击，但只在待办模式创建排序会话。
      if (this.view.state.facet(modeFacet) !== 'todo') return;
      session.preview = document.createElement('div'); session.preview.className = 'fm-drag-preview';
      const item = this.view.state.field(documentField).items.find(item => item.from === session.from);
      session.preview.textContent = item ? this.view.state.doc.sliceString(item.contentFrom, item.firstLineTo) || '空列表项' : '';
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
  private key = (event: KeyboardEvent): void => { if (event.key === 'Escape' && this.session) { event.preventDefault(); this.cancel(); } };
  private cancel = (): void => {
    cancelAnimationFrame(this.frame);
    this.session?.preview?.remove(); this.session?.line?.remove(); this.session = null;
    document.body.classList.remove('fm-dragging');
  };
  private context = (event: MouseEvent): void => {
    const marker = (event.target as Element).closest<HTMLElement>('[data-list-marker]');
    if (!marker) return;
    event.preventDefault();
    document.querySelector('.fm-item-menu')?.remove();
    const from = Number(marker.dataset.listMarker);
    const actions = this.view.state.facet(actionsFacet);
    const menu = document.createElement('div'); menu.className = 'fm-item-menu'; menu.setAttribute('role', 'menu');
    menu.style.left = `${event.clientX}px`; menu.style.top = `${event.clientY}px`;
    const entries: [string, () => void][] = [['折叠 / 展开', () => actions.toggleFold(from)]];
    if (this.view.state.facet(modeFacet) === 'todo') entries.push(['上移', () => actions.moveItem(from, 'up')], ['下移', () => actions.moveItem(from, 'down')]);
    const item = this.view.state.field(documentField).items.find(item => item.from === from);
    if (item?.task) entries.push([item.task.checked ? '恢复任务' : '完成整组', () => actions.toggleTask(from, true)]);
    for (const [label, action] of entries) { const button = document.createElement('button'); button.textContent = label; button.setAttribute('role', 'menuitem'); button.onclick = () => { menu.remove(); action(); }; menu.append(button); }
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.remove(); marker.focus(); } });
    document.body.append(menu); (menu.firstElementChild as HTMLElement).focus();
    const close = (event: Event): void => { if (!menu.contains(event.target as Node)) { menu.remove(); window.removeEventListener('pointerdown', close, true); } };
    window.addEventListener('pointerdown', close, true);
  };
}

export const markerGestures = ViewPlugin.fromClass(MarkerGestures);
