/**
 * 文件职责：承载唯一编辑视图与应用命令之间的协调入口。
 * 定义范围：编辑状态生命周期、公共编辑命令、界面状态恢复。
 */
import { Compartment, EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo, undo, isolateHistory } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { foldKey, getHiddenRanges, markdownExtensions, moveItemChanges, moveItemPosition, taskToggleChanges, type DocumentModel } from '../markdown';
import { actionsFacet, completionField, documentField, foldHistory, foldsField, holdCompletion, modeFacet, releaseCompletion, resourcesFacet, setFolds } from './state';
import { previewField } from './preview';
import { markerGestures } from './gestures';
import { taskKeymap } from './commands';
import { contentVisibility } from './visibility';
import { previewWindowField, previewWindowPlugin, setPreviewWindow } from './viewport';
import type { EditorOptions, ProjectView, ViewMode } from './types';
import 'katex/dist/katex.min.css';
import './editor.css';
export type { EditorOptions } from './types';

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
  private completionToken = 0;
  private readonly completionTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(parent: HTMLElement, options: EditorOptions) {
    this.options = options;
    this.view = new EditorView({ parent, state: this.createState(options.text, options.mode) });
    this.view.dom.addEventListener('keydown', this.historyKey, true);
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
      markdown({ extensions: markdownExtensions }),
      history(), drawSelection(), bracketMatching(), indentOnInput(), syntaxHighlighting(defaultHighlightStyle),
      this.mode.of(this.modeExtensions(mode)),
      resourcesFacet.of(this.options),
      actionsFacet.of({ toggleTask: (from, group) => this.toggleTask(from, group), toggleFold: from => this.toggleFold(from), moveItem: (from, direction) => this.moveItem(from, direction), moveTo: (from, boundary) => this.moveTo(from, boundary), focusAt: from => this.focusAt(from) }),
      documentField, foldsField, completionField, foldHistory, previewWindowField, contentVisibility, previewField, previewWindowPlugin, markerGestures,
      keymap.of([...taskKeymap, ...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      placeholder('写下第一件事，或输入 - [ ] 创建任务…'),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 任务文档', spellcheck: 'false' }),
      EditorView.updateListener.of(update => { if (update.docChanged) this.options.onChange(update.state.doc.toString()); }),
    ] });
  }

  private modeExtensions(mode: ViewMode): Extension[] { return [modeFacet.of(mode), EditorState.readOnly.of(mode === 'archive'), EditorView.editable.of(mode !== 'archive')]; }
  setMode(mode: ViewMode): void { this.view.dispatch({ effects: this.mode.reconfigure(this.modeExtensions(mode)) }); }

  /** 外部全文替换只恢复可可靠匹配的折叠键，避免位置复用误折叠另一条目。 */
  setText(text: string, resetHistory = false): void {
    const ui = this.getUIState();
    if (resetHistory) { this.clearCompletionTimers(); this.view.setState(this.createState(text, ui.mode)); this.setUIState(ui); return; }
    this.view.dispatch({ changes: { from: 0, to: this.state.doc.length, insert: text }, annotations: isolateHistory.of('full') });
    this.setUIState(ui);
  }
  restoreState(state: EditorState, ui?: ProjectView): void {
    this.groupPrompt?.remove(); this.clearCompletionTimers(); this.view.setState(state);
    this.view.dispatch({ effects: releaseCompletion.of('all'), annotations: Transaction.addToHistory.of(false) });
    if (ui) this.setUIState(ui);
  }
  getUIState(): ProjectView {
    const model = this.state.field(documentField);
    const folded = [...this.state.field(foldsField)].flatMap(from => { const item = model.items.find(item => item.from === from); const key = item ? foldKey(model, item) : ''; return key ? [key] : []; });
    return { mode: this.state.facet(modeFacet), cursor: this.state.selection.main.head, scrollTop: this.view.scrollDOM.scrollTop, folded };
  }
  setUIState(ui: ProjectView): void {
    const model = this.state.field(documentField);
    const keys = new Set(ui.folded.filter(Boolean));
    const folded = keys.size ? model.items.filter(item => keys.has(foldKey(model, item))).map(item => item.from) : [];
    this.view.dispatch({ selection: { anchor: Math.max(0, Math.min(ui.cursor, this.state.doc.length)) }, effects: [this.mode.reconfigure(this.modeExtensions(ui.mode)), setFolds.of(folded)], annotations: Transaction.addToHistory.of(false) });
    this.view.scrollDOM.scrollTop = ui.scrollTop;
  }
  focusAt(pos: number): void {
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
    const end = this.state.doc.length;
    const prefix = end && this.state.doc.sliceString(end - 1) !== '\n' ? '\n' : '';
    const insert = `${prefix}- [ ] `;
    this.view.dispatch({ changes: { from: end, insert }, selection: { anchor: end + insert.length }, annotations: isolateHistory.of('full'), scrollIntoView: true });
    this.view.focus();
  }
  undo(): boolean { return this.runHistory(undo); }
  redo(): boolean { return this.runHistory(redo); }

  /** 归档禁止自由编辑，但恢复命令已有文本历史，撤销必须仍可达。 */
  private runHistory(command: (view: EditorView) => boolean): boolean {
    const mode = this.state.facet(modeFacet);
    if (mode !== 'archive') return command(this.view);
    // 临时可写仅覆盖同步历史命令，DOM 始终不可编辑，并在返回前恢复只读契约。
    this.view.dispatch({ effects: this.mode.reconfigure([modeFacet.of(mode), EditorState.readOnly.of(false), EditorView.editable.of(false)]), annotations: Transaction.addToHistory.of(false) });
    try { return command(this.view); }
    finally { this.setMode(mode); }
  }
  private historyKey = (event: KeyboardEvent): void => {
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
      const token = ++this.completionToken;
      const effects = completing && this.state.facet(modeFacet) === 'todo' ? [holdCompletion.of({ token, from: itemFrom })] : [];
      this.view.dispatch({ changes, selection, effects, annotations: isolateHistory.of('full'), userEvent: 'input.complete' });
      if (effects.length) {
        const delay = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 140;
        const timer = setTimeout(() => {
          this.completionTimers.delete(timer);
          this.view.dispatch({ effects: releaseCompletion.of(token), annotations: Transaction.addToHistory.of(false) });
        }, delay);
        this.completionTimers.add(timer);
      }
      this.groupPrompt?.remove();
      this.options.onStatus?.(completing ? group ? '整组已完成，可撤销' : '任务已完成，可撤销' : '任务已恢复，可撤销');
    } catch (error) {
      if (error instanceof Error && error.message.includes('TASK_GROUP_REQUIRED')) { this.showGroupPrompt(itemFrom); return; }
      this.options.onStatus?.(error instanceof Error ? error.message : '任务操作失败');
    }
  }

  private showGroupPrompt(from: number): void {
    this.groupPrompt?.remove();
    const prompt = document.createElement('div'); prompt.className = 'fm-group-prompt'; prompt.setAttribute('role', 'status');
    const label = document.createElement('span'); label.textContent = '还有未完成子任务';
    const complete = document.createElement('button'); complete.textContent = '完成整组'; complete.onclick = () => this.toggleTask(from, true);
    const cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.onclick = () => prompt.remove();
    prompt.append(label, complete, cancel); this.view.dom.append(prompt); this.groupPrompt = prompt;
    this.options.onStatus?.('还有未完成子任务，请选择“完成整组”');
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
    this.view.dispatch({ effects: setFolds.of([...folds]), selection: willFold && intersects ? { anchor: item.firstLineTo } : undefined, annotations: Transaction.addToHistory.of(false) });
  }
  private clearCompletionTimers(): void { for (const timer of this.completionTimers) clearTimeout(timer); this.completionTimers.clear(); }
  destroy(): void { this.groupPrompt?.remove(); this.clearCompletionTimers(); this.view.dom.removeEventListener('keydown', this.historyKey, true); this.view.destroy(); }
}
