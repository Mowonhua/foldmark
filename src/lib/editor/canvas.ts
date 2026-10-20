/**
 * 文件职责：把原子画布快照连接到当前 Markdown 编辑器。
 * 定义范围：卡片控件、范围身份跟踪、会话提交与就地插入。
 */
import { Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { WidgetType, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { CanvasDocument, CanvasSession } from '../canvas/types';
import { createCanvasDocument, parseCanvasDocument, scanCanvasBlocks, serializeCanvasDocument } from '../canvas/model';
import type { SourceReturn } from '../contracts';
import { actionsFacet, documentField, modeFacet, resourcesFacet, sourceViewFacet } from './state';
import { createCanvasThumbnail } from '../canvas/thumbnail';
import { paragraphAt, paragraphLayout } from './paragraphs';
import { captureSourcePosition, restoreSourcePosition } from './source-position';
import { hiddenContentRanges } from './visibility';
import { archiveSections } from '../markdown';

/** 源文身份只跟随范围映射；即使正文恢复原样，被外部改动过的会话也不会复活。 */
interface CanvasAnchor {
  from: number;
  to: number;
  baseline: string;
  document: CanvasDocument;
  position: SourceReturn;
  valid: boolean;
  submitting: boolean;
}

/**
 * 接口职责：维护附着于当前编辑视图的画布编辑会话。
 * 调用方：EditorController 与画布卡片动作。
 * 实现要求：只替换打开的源文范围；重载、删除、外部改写或只读状态均不得覆盖原文。
 */
export class CanvasEditor {
  private active?: CanvasAnchor;
  private generation = 0;
  constructor(private readonly view: EditorView, private readonly openCanvas?: (session: CanvasSession) => void) {}

  /** 查询当前视图和光标能否插入画布；菜单展示与实际提交使用同一约束。 */
  canInsert(): boolean {
    const { state } = this.view;
    if (!this.openCanvas || this.readOnly() || this.view.composing || state.selection.ranges.length !== 1) return false;
    const cursor = state.selection.main.head;
    if (hiddenContentRanges(state).some(range => cursor >= range.from && (cursor < range.to || cursor === state.doc.length && cursor === range.to))) return true;
    const layout = paragraphLayout(state), paragraph = layout.paragraphs[paragraphAt(layout, cursor)];
    return paragraph?.kind !== 'literal' || state.field(documentField).headings.some(heading => cursor >= heading.from && cursor <= heading.to);
  }

  /**
   * 函数职责：跟随正文事务映射会话范围并识别外部改动。
   * 输入说明：update 来自唯一 EditorView 的 updateListener。
   * 输出说明：不产生嵌套事务；相交改动使会话永久失效。
   * 实现思路：按事务旧坐标检测范围交叉，再映射范围与阅读位置。
   */
  update(update: ViewUpdate): void {
    const anchor = this.active;
    if (!anchor) return;
    for (const transaction of update.transactions) {
      if (!transaction.docChanged) continue;
      transaction.changes.iterChangedRanges((from, to) => {
        if (!anchor.submitting && (from === to ? from > anchor.from && from < anchor.to : from < anchor.to && to > anchor.from)) anchor.valid = false;
      });
      anchor.from = transaction.changes.mapPos(anchor.from, anchor.submitting ? -1 : 1);
      anchor.to = transaction.changes.mapPos(anchor.to, anchor.submitting ? 1 : -1);
      anchor.position = { ...anchor.position, anchor: transaction.changes.mapPos(anchor.position.anchor, 1), cursor: transaction.changes.mapPos(anchor.position.cursor, 1) };
    }
  }

  /**
   * 函数职责：让旧文档的全部会话失效。
   * 输入说明：文档切换、重载或视图销毁前调用。
   * 输出说明：后续 commit 和 close 不得修改新文档与阅读位置。
   * 实现思路：取消当前会话身份与延迟位置恢复。
   */
  invalidate(): void { this.active = undefined; this.generation++; }

  /**
   * 函数职责：打开指定源文画布。
   * 输入说明：from 必须是当前闭合且格式受支持的画布范围起点。
   * 输出说明：有应用回调且打开成功返回 true；归档会话只读。
   * 实现思路：复制快照，以当前范围和原文基线建立局部提交闭包。
   */
  open(from: number): boolean {
    if (!this.openCanvas) return false;
    const state = this.view.state;
    const block = scanCanvasBlocks(state.doc.toString(), state.field(documentField).tree).find(block => block.from === from);
    if (!block?.document) return false;
    this.invalidate();
    const generation = this.generation;
    const anchor: CanvasAnchor = { from: block.from, to: block.to, baseline: state.doc.sliceString(block.from, block.to),
      document: block.document, position: captureSourcePosition(this.view), valid: true, submitting: false };
    this.active = anchor;
    const readOnly = this.readOnly();
    this.openCanvas({
      document: parseCanvasDocument(serializeCanvasDocument(block.document))!, readOnly,
      commit: next => !readOnly && this.commit(anchor, next),
      close: () => {
        if (this.active !== anchor) return;
        this.active = undefined;
        this.view.dispatch({ selection: { anchor: Math.min(anchor.position.cursor, this.view.state.doc.length) }, annotations: Transaction.addToHistory.of(false) });
        this.view.focus();
        restoreSourcePosition(this.view, anchor.position, () => this.generation === generation);
      },
    });
    return true;
  }

  /**
   * 函数职责：在光标所在段落后插入新画布并打开。
   * 输入说明：只接受可编辑单选区，字面块中不拆分已有语法。
   * 输出说明：插入成功返回 true，一次撤销移除整块。
   * 实现思路：复用段落与列表容器缩进，保留可继续输入的正文出口。
   */
  insert(): boolean {
    const { state } = this.view;
    if (!this.canInsert()) return false;
    const cursor = state.selection.main.head;
    // 浏览器的文末导航可把光标放到过滤分区末端；插入位置不能沿用不可见原文坐标。
    // 折叠内容中的落点统一退回待办末尾，避免新画布仍被原父项的折叠范围遮住。
    const hidden = hiddenContentRanges(state).find(range => cursor >= range.from && (cursor < range.to || cursor === state.doc.length && cursor === range.to));
    if (hidden) {
      const from = state.facet(modeFacet) === 'source' ? hidden.from : archiveSections(state.field(documentField))[0]?.from ?? state.doc.length;
      const breaks = /\n*$/.exec(state.doc.sliceString(Math.max(0, from - 2), from))![0].length;
      return this.writeInsert(from, from, from ? '\n'.repeat(Math.max(0, 2 - breaks)) : '', '');
    }
    const layout = paragraphLayout(state);
    const paragraph = layout.paragraphs[paragraphAt(layout, cursor)];
    // 段落投影把标题也归为独立块；标题后可新增画布，代码及公式内部仍不能拆分。
    const heading = state.field(documentField).headings.some(heading => cursor >= heading.from && cursor <= heading.to);
    if (paragraph?.kind === 'literal' && !heading) return false;
    const line = state.doc.lineAt(cursor);
    const empty = !line.text.trim();
    let indent = paragraph?.indent ?? '';
    if (paragraph?.item) {
      const first = state.doc.lineAt(paragraph.item.from);
      const markerEnd = paragraph.item.markerTo - first.from;
      indent = ' '.repeat(markerEnd + (first.text.slice(markerEnd).match(/^[ \t]+/)?.[0].length ?? 0));
    }
    const from = empty ? line.from : state.doc.lineAt(paragraph?.to ?? cursor).to;
    const to = empty ? line.to : from;
    const prefix = empty ? '' : '\n\n';
    return this.writeInsert(from, to, prefix, indent);
  }

  /** 完整插入与输入出口共享同一事务；调用前位置必须已经收敛到当前可见分区。 */
  private writeInsert(from: number, to: number, prefix: string, indent: string): boolean {
    const document = createCanvasDocument();
    const source = `${indent}\`\`\`canvas\n${indent}${serializeCanvasDocument(document)}\n${indent}\`\`\``;
    const insert = `${prefix}${source}\n\n${indent}`;
    this.view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, annotations: isolateHistory.of('full'), userEvent: 'input.canvas' });
    return this.open(from + prefix.length);
  }

  private readOnly(): boolean {
    const { state } = this.view;
    return state.readOnly || state.facet(modeFacet) === 'archive' || state.facet(sourceViewFacet) === 'archive';
  }

  /** 每次完整快照作为一次历史单元；先比较基线，再局部替换，禁止引擎覆盖外部正文。 */
  private commit(anchor: CanvasAnchor, next: CanvasDocument): boolean {
    if (this.active !== anchor || !anchor.valid || this.readOnly() || next.id !== anchor.document.id) return false;
    const { state } = this.view;
    if (state.doc.sliceString(anchor.from, anchor.to) !== anchor.baseline) { anchor.valid = false; return false; }
    const block = scanCanvasBlocks(state.doc.toString(), state.field(documentField).tree).find(block => block.from === anchor.from && block.to === anchor.to);
    if (!block?.document) return false;
    try {
      // 删除图形只移除使用关系，旧文件引用保留给引擎和正文历史中的恢复动作。
      const document = { ...next, files: { ...anchor.document.files, ...next.files } };
      const json = serializeCanvasDocument(document);
      const source = anchor.baseline.slice(0, block.bodyFrom - block.from) + block.indent + json + anchor.baseline.slice(block.bodyTo - block.from);
      if (source === anchor.baseline) return true;
      anchor.submitting = true;
      this.view.dispatch({ changes: { from: anchor.from, to: anchor.to, insert: source }, annotations: isolateHistory.of('full'), userEvent: 'input.canvas' });
      anchor.baseline = source; anchor.document = parseCanvasDocument(json)!;
      if (this.view.state.doc.sliceString(anchor.from, anchor.to) !== source) { anchor.valid = false; return false; }
      return true;
    } catch { return false; }
    finally { anchor.submitting = false; }
  }
}

const previews = new WeakMap<HTMLElement, () => void>();

/** 卡片在预览模式始终折叠；所有事件读取当前 DOM 坐标，不捕获可能过期的位置。 */
export class CanvasWidget extends WidgetType {
  constructor(readonly canvas: CanvasDocument, readonly from: number) { super(); }
  eq(other: CanvasWidget): boolean { return this.canvas === other.canvas && this.from === other.from; }
  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement('div'); card.className = 'fm-canvas-card'; card.dataset.canvasFrom = String(this.from);
    const title = document.createElement('span'); title.className = 'fm-canvas-title'; title.textContent = this.canvas.title || '画布';
    const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'fm-canvas-expand';
    expand.setAttribute('aria-label', `展开画布：${this.canvas.title || '画布'}`); expand.title = '展开画布';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 20 20'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M12 3h5v5 M17 3l-6 6 M8 17H3v-5 M3 17l6-6');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); icon.append(path); expand.append(icon);
    expand.addEventListener('click', () => view.state.facet(actionsFacet).openCanvas(Number(card.dataset.canvasFrom)));
    const preview = createCanvasThumbnail(this.canvas, view.state.facet(resourcesFacet).resolveCanvasImage);
    previews.set(card, preview.dispose);
    card.append(preview.element, title, expand); return card;
  }
  destroy(dom: HTMLElement): void { previews.get(dom)?.(); previews.delete(dom); }
  ignoreEvent(): boolean { return true; }
}
