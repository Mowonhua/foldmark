/**
 * 文件职责：承载唯一编辑视图与应用命令之间的协调入口。
 * 定义范围：编辑状态生命周期、公共编辑命令、界面状态恢复。
 */
import { Compartment, EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo, undo, isolateHistory } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { archiveSections, foldKey, getHiddenRanges, markdownExtensions, moveItemChanges, moveItemPosition, taskIsArchived, taskToggleChanges, type DocumentModel } from '../markdown';
import { actionsFacet, documentField, foldHistory, foldsField, modeFacet, resourcesFacet, setFolds, sourceViewFacet, softBreaksField, softBreakHistory } from './state';
import { previewField } from './preview';
import { archiveLayoutSpec } from './archive-layout';
import { refreshSourceScope, sourceScopeExtension } from './source-scope';
import { captureSourcePosition, restoreSourcePosition, setSourceReturn, sourcePositionHistory, sourceReturnField } from './source-position';
import { markerGestures } from './gestures';
import { draftFencedBlocksField, draftFencedBlockHistory } from './fenced-block-state';
import { taskKeymap } from './commands';
import { contentVisibility } from './visibility';
import { foldMotion } from './fold-motion';
import { codeSelection } from './selection';
import { previewWindowField, previewWindowPlugin, setPreviewWindow } from './viewport';
import type { EditorOptions, ProjectView, ViewMode } from './types';
import 'katex/dist/katex.min.css';
import './editor.css';
export type { EditorOptions } from './types';

/** 语法颜色必须引用主题变量，切换主题时无须重建编辑器或丢失选区与撤销历史。 */
const themeHighlightStyle = HighlightStyle.define([
  { tag: [tags.meta, tags.comment], color: 'var(--muted)' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.heading, color: 'var(--ink)', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.keyword, tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName, tags.literal, tags.inserted, tags.regexp, tags.escape, tags.typeName, tags.namespace, tags.className, tags.macroName], color: 'var(--accent)' },
  { tag: [tags.variableName, tags.propertyName], color: 'var(--ink)' },
  { tag: [tags.deleted, tags.invalid], color: 'var(--danger)' },
]);

/** 读取当前语法投影，应用统计和搜索直接复用它，不再次解析同一正文。 */
export function getDocumentModel(state: EditorState): DocumentModel { return state.field(documentField); }

/**
 * 接口职责：向应用提供文档命令，内部状态是当前正文的唯一编辑来源。
 * 调用方：应用当前项目的挂载点。
 * 实现要求：切换项目使用原 EditorState 恢复各自历史；界面折叠不写文本历史。
 */
export class EditorController {
  readonly view: EditorView;
  private readonly mode = new Compartment();
  private readonly options: EditorOptions;
  private groupPrompt: HTMLElement | null = null;
  private positionGeneration = 0;

  constructor(parent: HTMLElement, options: EditorOptions) {
    this.options = options;
    this.view = new EditorView({ parent, state: this.createState(options.text, options.mode) });
    this.view.dom.addEventListener('keydown', this.historyKey, true);
    this.view.scrollDOM.addEventListener('wheel', this.cancelPositionRestore, { passive: true });
    this.view.scrollDOM.addEventListener('pointerdown', this.cancelPositionRestore);
    this.view.dom.addEventListener('keydown', this.cancelPositionRestore, true);
  }
  get state(): EditorState { return this.view.state; }
  get text(): string { return this.state.doc.toString(); }
  get model(): DocumentModel { return getDocumentModel(this.state); }

  /**
   * 函数职责：为当前或后台项目生成不带旧历史的文档状态。
   * 输入说明：文本来自文件层；模式必须对应所属项目。
   * 输出说明：不挂载视图、不触发正文回调，创建状态可交给 restoreState。
   * 实现思路：复用控制器端口与扩展，独立创建 CodeMirror 历史字段。
   */
  createState(text: string, mode: ViewMode): EditorState {
    return EditorState.create({ doc: text, extensions: [
      // Markdown 默认会以高优先级注册 Enter；键盘顺序统一由下方组合，保证围栏自动闭合先执行。
      markdown({ extensions: markdownExtensions, addKeymap: false }),
      // 源码输入不搬移光标；撤销重做必须准确恢复历史，不能再次触发布局整理。
      EditorState.transactionFilter.of(transaction => {
        if (!transaction.docChanged || transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.state.facet(modeFacet) === 'source') return transaction;
        const layout = archiveLayoutSpec(transaction.state);
        return layout ? [transaction, layout] : transaction;
      }),
      history(), drawSelection(), codeSelection, bracketMatching(), indentOnInput(), syntaxHighlighting(themeHighlightStyle),
      this.mode.of(this.modeExtensions(mode)),
      resourcesFacet.of(this.options),
      actionsFacet.of({ toggleTask: (from, group) => this.toggleTask(from, group), toggleFold: from => this.toggleFold(from), moveItem: (from, direction) => this.moveItem(from, direction), moveTo: (from, boundary) => this.moveTo(from, boundary), focusAt: from => this.focusAt(from) }),
      documentField, foldsField, foldHistory, softBreaksField, softBreakHistory, draftFencedBlocksField, draftFencedBlockHistory, sourceScopeExtension, sourceReturnField, sourcePositionHistory, previewWindowField, contentVisibility, previewField, previewWindowPlugin, markerGestures, foldMotion,
      keymap.of([...taskKeymap, ...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      placeholder('写下第一件事，或输入 - [ ] 创建任务…'),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 任务文档', spellcheck: 'false' }),
      EditorView.updateListener.of(update => { if (update.docChanged) this.options.onChange(update.state.doc.toString()); }),
    ] });
  }

  private modeExtensions(mode: ViewMode, sourceView: 'todo' | 'archive' = mode === 'archive' ? 'archive' : 'todo'): Extension[] {
    return [modeFacet.of(mode), sourceViewFacet.of(sourceView), EditorState.readOnly.of(mode === 'archive'), EditorView.editable.of(mode !== 'archive')];
  }
  /** 在来源分区的预览与源码之间切换；返回时使用进入源码前的阅读位置。 */
  toggleSource(organize = true): void {
    this.setMode(this.state.facet(modeFacet) === 'source' ? this.state.facet(sourceViewFacet) : 'source', organize);
  }
  /** organize=false 用于尚有受保护恢复草稿时仅切换显示，避免视图操作改写恢复数据。 */
  setMode(mode: ViewMode, organize = true): void {
    const previous = this.state.facet(modeFacet);
    if (previous === mode) return;
    const enteringSource = mode === 'source';
    const leavingSource = previous === 'source';
    const origin = enteringSource ? previous as 'todo' | 'archive' : this.state.facet(sourceViewFacet);
    const current = captureSourcePosition(this.view);
    const returning = leavingSource && mode === origin;
    const target = returning ? this.state.field(sourceReturnField) ?? current : current;
    const generation = ++this.positionGeneration;
    this.view.dispatch({
      effects: [
        this.mode.reconfigure(this.modeExtensions(mode, enteringSource ? origin : mode as 'todo' | 'archive')),
        setSourceReturn.of(enteringSource ? current : returning ? target : null),
        setPreviewWindow.of({ from: Math.max(0, target.anchor - 3000), to: Math.min(this.state.doc.length, target.anchor + 3000) }),
      ],
      selection: returning ? { anchor: Math.min(target.cursor, this.state.doc.length) } : undefined,
      annotations: Transaction.addToHistory.of(false),
    });
    if (leavingSource && organize) this.normalizeArchive();
    const mappedTarget = returning ? this.state.field(sourceReturnField) ?? target : target;
    if (leavingSource) this.view.dispatch({ effects: setSourceReturn.of(null), annotations: Transaction.addToHistory.of(false) });
    // 预览和源码的行高不同，原始 scrollTop 不能表示同一阅读位置。
    if (enteringSource || returning) restoreSourcePosition(this.view, mappedTarget, () => generation === this.positionGeneration);
  }

  /** 将文件布局整理作为可撤销正文操作；应用应在保存协调器就绪后调用。 */
  normalizeArchive(): void {
    if (this.state.facet(modeFacet) === 'source') return;
    const spec = archiveLayoutSpec(this.state);
    if (spec) this.view.dispatch({ ...spec, annotations: isolateHistory.of('full'), filter: false });
    const warning = this.archiveLayoutWarning();
    if (warning) this.options.onStatus?.(warning);
  }

  /** 未闭合语法可能吞掉追加标题；共享内核拒绝移动时必须让用户知道尚未完成布局整理。 */
  private archiveLayoutWarning(): string | null {
    if (this.state.facet(modeFacet) === 'source') return null;
    const model = this.model;
    const sections = archiveSections(model);
    return model.tasks.some(item => taskIsArchived(model, item) && !sections.some(section => item.from >= section.headingTo && item.to <= section.to))
      ? '暂缓整理归档：请检查源码中的代码围栏或 HTML 是否完整。' : null;
  }

  /** 外部全文替换只恢复可可靠匹配的折叠键，避免位置复用误折叠另一条目。 */
  setText(text: string, resetHistory = false): void {
    this.positionGeneration++;
    const ui = this.getUIState();
    if (resetHistory) { this.view.setState(this.createState(text, ui.mode)); this.setUIState(ui); return; }
    this.view.dispatch({ changes: { from: 0, to: this.state.doc.length, insert: text }, effects: refreshSourceScope.of(null), annotations: isolateHistory.of('full') });
    this.setUIState(ui);
  }
  restoreState(state: EditorState, ui?: ProjectView): void {
    this.positionGeneration++;
    this.closeGroupPrompt(); this.view.setState(state);
    if (ui) this.setUIState(ui);
  }
  getUIState(): ProjectView {
    const model = this.state.field(documentField);
    const folded = [...this.state.field(foldsField)].flatMap(from => { const item = model.items.find(item => item.from === from); const key = item ? foldKey(model, item) : ''; return key ? [key] : []; });
    const mode = this.state.facet(modeFacet);
    const sourceReturn = this.state.field(sourceReturnField);
    return { mode, cursor: this.state.selection.main.head, scrollTop: this.view.scrollDOM.scrollTop, folded,
      ...(mode === 'source' ? { sourceView: this.state.facet(sourceViewFacet), ...(sourceReturn ? { sourceReturn } : {}) } : {}),
    };
  }
  setUIState(ui: ProjectView): void {
    this.positionGeneration++;
    const model = this.state.field(documentField);
    const keys = new Set(ui.folded.filter(Boolean));
    const folded = keys.size ? model.items.filter(item => keys.has(foldKey(model, item))).map(item => item.from) : [];
    const sourceReturn = ui.sourceReturn ? { ...ui.sourceReturn, cursor: Math.min(ui.sourceReturn.cursor, this.state.doc.length), anchor: Math.min(ui.sourceReturn.anchor, this.state.doc.length) } : null;
    this.view.dispatch({ selection: { anchor: Math.max(0, Math.min(ui.cursor, this.state.doc.length)) }, effects: [this.mode.reconfigure(this.modeExtensions(ui.mode, ui.sourceView ?? (ui.mode === 'archive' ? 'archive' : 'todo'))), setFolds.of(folded), setSourceReturn.of(ui.mode === 'source' ? sourceReturn : null)], annotations: Transaction.addToHistory.of(false) });
    this.view.scrollDOM.scrollTop = ui.scrollTop;
  }
  focusAt(pos: number): void {
    this.positionGeneration++;
    const anchor = Math.max(0, Math.min(pos, this.state.doc.length));
    const model = this.state.field(documentField);
    const folds = [...this.state.field(foldsField)].filter(from => { const item = model.items.find(item => item.from === from); return !item || anchor <= item.firstLineTo || anchor > item.to; });
    const window = this.state.field(previewWindowField);
    const viewportEffect = anchor < window.from || anchor > window.to ? [setPreviewWindow.of({ from: Math.max(0, anchor - 3000), to: Math.min(this.state.doc.length, anchor + 3000) })] : [];
    this.view.dispatch({ selection: { anchor }, effects: [setFolds.of(folds), ...viewportEffect, EditorView.scrollIntoView(anchor, { y: 'center' })], annotations: Transaction.addToHistory.of(false) });
    this.view.focus();
  }
  insertTask(): void {
    if (this.state.facet(modeFacet) === 'archive') this.setMode('todo');
    const end = archiveSections(this.model)[0]?.from ?? this.state.doc.length;
    const prefix = end && this.state.doc.sliceString(end - 1, end) !== '\n' ? '\n' : '';
    const insert = `${prefix}- [ ] `;
    const suffix = end < this.state.doc.length ? '\n\n' : '';
    this.view.dispatch({ changes: { from: end, insert: insert + suffix }, selection: { anchor: end + insert.length }, annotations: isolateHistory.of('full'), scrollIntoView: true });
    this.view.focus();
  }
  undo(): boolean { return this.runHistory(undo); }
  redo(): boolean { return this.runHistory(redo); }

  /** 归档禁止自由编辑，但恢复命令已有文本历史，撤销必须仍可达。 */
  private runHistory(command: (view: EditorView) => boolean): boolean {
    const mode = this.state.facet(modeFacet);
    if (mode !== 'archive') return command(this.view);
    // 临时可写仅覆盖同步历史命令，DOM 始终不可编辑，并在返回前恢复只读契约。
    this.view.dispatch({ effects: this.mode.reconfigure([modeFacet.of(mode), sourceViewFacet.of('archive'), EditorState.readOnly.of(false), EditorView.editable.of(false)]), annotations: Transaction.addToHistory.of(false) });
    try { return command(this.view); }
    finally { this.view.dispatch({ effects: this.mode.reconfigure(this.modeExtensions(mode)), annotations: Transaction.addToHistory.of(false) }); }
  }
  private historyKey = (event: KeyboardEvent): void => {
    // 嵌入语言输入框使用浏览器自己的文本历史，不能把其撤销快捷键送给正文。
    if (event.target instanceof Element && event.target.closest('.fm-code-language')) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || this.view.composing) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault(); event.stopPropagation();
    if (key === 'y' || event.shiftKey) this.redo(); else this.undo();
  };

  toggleTask(itemFrom: number, group = false): void {
    const model = this.state.field(documentField);
    const item = model.items.find(item => item.from === itemFrom);
    if (!item?.task) return;
    try {
      const changes = taskToggleChanges(model, itemFrom, group);
      const current = this.state.selection.main;
      const anchorInside = current.from >= item.from && current.to <= item.to;
      const next = model.tasks.find(candidate => candidate.from > item.to && !candidate.task?.checked);
      // 只在被隐藏范围包含现有选区时迁移光标；鼠标完成其他项不得抢走编辑位置。
      const selection = !item.task.checked && anchorInside ? { anchor: next?.contentFrom ?? model.text.length } : undefined;
      const completing = group || !item.task.checked;
      this.view.dispatch({ changes, selection, annotations: isolateHistory.of('full'), userEvent: 'input.complete' });
      this.closeGroupPrompt();
      this.options.onStatus?.(this.archiveLayoutWarning() ?? (completing ? group ? '整组已完成，可撤销' : '任务已完成，可撤销' : '任务已恢复，可撤销'));
    } catch (error) {
      if (error instanceof Error && error.message.includes('TASK_GROUP_REQUIRED')) { this.showGroupPrompt(itemFrom); return; }
      this.options.onStatus?.(error instanceof Error ? error.message : '任务操作失败');
    }
  }

  private showGroupPrompt(from: number): void {
    this.closeGroupPrompt();
    const prompt = document.createElement('div'); prompt.className = 'fm-group-prompt'; prompt.setAttribute('role', 'status');
    const label = document.createElement('span'); label.textContent = '还有未完成子任务';
    const complete = document.createElement('button'); complete.textContent = '完成整组'; complete.onclick = () => this.toggleTask(from, true);
    const cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.onclick = () => this.closeGroupPrompt();
    prompt.append(label, complete, cancel); this.view.dom.append(prompt); this.groupPrompt = prompt;
    // 捕获下一次按下，避免被触发本提示的 click 立即关闭，也避免正文阻止冒泡后漏掉外部操作。
    window.addEventListener('pointerdown', this.dismissGroupPrompt, true);
    this.options.onStatus?.('还有未完成子任务，请选择“完成整组”');
  }

  private dismissGroupPrompt = (event: Event): void => {
    if (event.target instanceof Node && !this.groupPrompt?.contains(event.target)) this.closeGroupPrompt();
  };

  /** 所有退出路径共用清理，防止已切换或销毁的编辑器仍持有窗口监听。 */
  private closeGroupPrompt(): void {
    window.removeEventListener('pointerdown', this.dismissGroupPrompt, true);
    this.groupPrompt?.remove(); this.groupPrompt = null;
  }

  moveItem(itemFrom: number, direction: 'up' | 'down'): void {
    if (this.state.facet(modeFacet) !== 'todo') return;
    const model = this.state.field(documentField);
    const item = model.items.find(item => item.from === itemFrom);
    if (!item) return;
    const hidden = getHiddenRanges(model, 'todo');
    const siblings = model.items.filter(candidate => candidate.listFrom === item.listFrom && candidate.parentFrom === item.parentFrom);
    const visible = siblings.filter(candidate => !hidden.some(range => candidate.from >= range.from && candidate.from < range.to));
    const index = visible.indexOf(item);
    if (direction === 'up' && index > 0) this.moveTo(itemFrom, visible[index - 1].from);
    if (direction === 'down' && index >= 0 && index < visible.length - 1) {
      const next = visible[index + 1];
      this.moveTo(itemFrom, siblings[siblings.indexOf(next) + 1]?.from ?? null);
    }
  }

  /** 移动的选区与折叠使用原条目内部位移；其他坐标使用标准事务映射。 */
  private moveTo(from: number, boundary: number | null): void {
    if (this.state.facet(modeFacet) !== 'todo') return;
    const model = this.state.field(documentField);
    const item = model.items.find(item => item.from === from);
    if (!item) return;
    try {
      const changes = this.state.changes(moveItemChanges(model, from, boundary));
      if (changes.empty) return;
      const map = (position: number): number => position >= item.moveFrom && position < item.moveTo ? moveItemPosition(model, from, boundary, position) : changes.mapPos(position, 1);
      const selection = EditorSelection.create(this.state.selection.ranges.map(range => EditorSelection.range(map(range.anchor), map(range.head))), this.state.selection.mainIndex);
      const folds = [...this.state.field(foldsField)].map(map);
      const coords = this.view.coordsAtPos(item.from);
      const scroll = this.view.scrollDOM.scrollTop;
      this.view.dispatch({ changes, selection, effects: setFolds.of(folds), annotations: isolateHistory.of('full'), userEvent: 'move' });
      const moved = this.view.coordsAtPos(map(item.from));
      if (coords && moved) this.view.scrollDOM.scrollTop = scroll + moved.top - coords.top;
      this.options.onStatus?.('条目已移动，可撤销');
    } catch (error) { this.options.onStatus?.(error instanceof Error ? error.message : '无法移动条目'); }
  }

  toggleFold(itemFrom: number): void {
    const item = this.state.field(documentField).items.find(item => item.from === itemFrom);
    if (!item || item.to <= item.firstLineTo) return;
    const folds = new Set(this.state.field(foldsField));
    const willFold = !folds.has(itemFrom);
    if (willFold) folds.add(itemFrom); else folds.delete(itemFrom);
    const selection = this.state.selection.main;
    const intersects = selection.to > item.firstLineTo && selection.from < item.to;
    const change = () => this.view.dispatch({ effects: setFolds.of([...folds]), selection: willFold && intersects ? { anchor: item.firstLineTo } : undefined, annotations: Transaction.addToHistory.of(false) });
    const motion = this.view.plugin(foldMotion);
    if (motion) motion.run(change); else change();
  }
  /** 用户开始滚动或编辑后，旧的异步切换测量不能抢回阅读位置。 */
  private cancelPositionRestore = (): void => { this.positionGeneration++; };
  destroy(): void {
    this.positionGeneration++; this.closeGroupPrompt();
    this.view.dom.removeEventListener('keydown', this.historyKey, true);
    this.view.dom.removeEventListener('keydown', this.cancelPositionRestore, true);
    this.view.scrollDOM.removeEventListener('wheel', this.cancelPositionRestore);
    this.view.scrollDOM.removeEventListener('pointerdown', this.cancelPositionRestore);
    this.view.destroy();
  }
}
