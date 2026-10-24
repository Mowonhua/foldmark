/**
 * 文件职责：承载唯一编辑视图与应用命令之间的协调入口。
 * 定义范围：编辑状态生命周期、公共编辑命令、界面状态恢复。
 */
import { translate, locale } from '../i18n';
import { Compartment, EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo, undo, isolateHistory, indentMore, indentLess } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { archiveSections, completedChildGroups, foldKey, getHiddenRanges, markdownExtensions, moveItemChanges, moveItemPosition, taskIsArchived, taskIsComplete, taskToggleChanges, type DocumentModel } from '../markdown';
import { actionsFacet, documentField, expandedCompletedGroupsField, foldHistory, foldsField, headingAddFacet, modeFacet, resourcesFacet, revalidateSoftBreaks, setExpandedCompletedGroups, setFolds, sourceViewFacet, softBreaksField, softBreakHistory } from './state';
import { previewField, previewComposition, headingAddHover } from './preview';
import { archiveLayoutSpec } from './archive-layout';
import { refreshSourceScope, sourceScopeExtension, sourceScopeField } from './source-scope';
import { isSyncStreamUpdate, SyncStream, syncArrivalExtension } from './sync-stream';
import { captureSourcePosition, restoreSourcePosition, setSourceReturn, sourcePositionHistory, sourceReturnField } from './source-position';
import { markerGestures } from './gestures';
import { draftFencedBlocksField, draftFencedBlockHistory } from './fenced-block-state';
import { taskKeymap, indentTask } from './commands';
import { paragraphAt, paragraphLayout } from './paragraphs';
import { contentVisibility } from './visibility';
import { foldMotion } from './fold-motion';
import { codeSelection } from './selection';
import { bracketCompletion, compositionBracketCompletion, matchingBrackets, pairedSymbols, pairingCaret, singleSymbolPairs } from './paired-symbols';
import { clipboard } from '../clipboard';
import { EditorContextMenu } from './context-menu';
import { previewWindowField, previewWindowPlugin, setPreviewWindow } from './viewport';
import { revealViewport } from './reveal';
import { CanvasEditor, canvasEditing, moveCanvasBlock } from './canvas';
import type { DragKind, EditorOptions, ProjectView, ViewMode } from './types';
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
  private readonly language = new Compartment();
  private readonly headingAdd = new Compartment();
  private headingAddEnabled = false;
  private readonly unsubscribeLocale: () => void;
  private readonly options: EditorOptions;
  private groupPrompt: HTMLElement | null = null;
  private positionGeneration = 0;
  /** 分段接收落定后的应用侧回调；新的接收、整份替换或项目切换都会替换或丢弃它。 */
  private pendingSettle?: () => void;
  private streamInstance?: SyncStream;
  private readonly contextMenu?: EditorContextMenu;
  private readonly canvasEditor: CanvasEditor;

  constructor(parent: HTMLElement, options: EditorOptions) {
    this.options = options;
    // createState 读取开关初值，必须先于编辑器状态构建赋值。
    this.headingAddEnabled = options.headingAddEnabled ?? false;
    this.view = new EditorView({ parent, state: this.createState(options.text, options.mode) });
    this.canvasEditor = new CanvasEditor(this.view, options.openCanvas);
    if (!options.nativeSelection) this.contextMenu = new EditorContextMenu(this.view, { clipboard: options.clipboard ?? clipboard,
      undo: () => this.undo(), redo: () => this.redo(), onStatus: options.onStatus,
      canvas: options.openCanvas ? { canInsert: () => this.canvasEditor.canInsert(), insert: () => this.insertCanvas(), remove: from => this.canvasEditor.remove(from) } : undefined });
    this.unsubscribeLocale = locale.subscribe(() => this.refreshLanguage());
    this.view.dom.addEventListener('keydown', this.historyKey, true);
    this.view.scrollDOM.addEventListener('wheel', this.cancelPositionRestore, { passive: true });
    this.view.scrollDOM.addEventListener('pointerdown', this.cancelPositionRestore);
    this.view.dom.addEventListener('keydown', this.cancelPositionRestore, true);
  }
  get state(): EditorState { return this.view.state; }
  get text(): string { return this.state.doc.toString(); }
  get model(): DocumentModel { return getDocumentModel(this.state); }

  private get stream(): SyncStream {
    this.streamInstance ??= new SyncStream(this.view, { settled: () => this.settleSynchronizedText() });
    return this.streamInstance;
  }

  /** 触屏辅助栏复用键盘命令；组合输入尚未结束时不提交结构变更。 */
  mobileCommand(command: 'task' | 'indent' | 'outdent' | 'up' | 'down' | 'undo' | 'redo'): void {
    if (this.view.composing) return;
    if (command === 'task') this.insertTask();
    else if (command === 'indent' || command === 'outdent') {
      if (!indentTask(this.view, command === 'indent' ? 1 : -1)) (command === 'indent' ? indentMore : indentLess)(this.view);
    }
    else if (command === 'undo') this.undo();
    else if (command === 'redo') this.redo();
    else {
      const position = this.state.selection.main.head;
      const item = this.model.items.filter(item => position >= item.from && position <= item.to).at(-1);
      if (item) this.moveItem(item.from, command);
    }
    this.view.focus();
  }

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
        const before = transaction.startState.field(documentField);
        const after = transaction.state.field(documentField);
        const checked = new Set(after.tasks.filter(item => taskIsComplete(after, item)).map(item => item.from));
        // 完成顺序由这笔动作提供，普通正文编辑和重新加载不重新排列已完成同级。
        const completedFrom = before.tasks.filter(item => !taskIsComplete(before, item))
          .map(item => transaction.changes.mapPos(item.from, 1)).filter(from => checked.has(from));
        const layout = archiveLayoutSpec(transaction.state, completedFrom);
        return layout ? [transaction, layout] : transaction;
      }),
      // Android 由系统维护选字手柄与操作菜单；桌面选区绘制会隐藏原生选区，导致长按菜单消失。
      history(), this.options.nativeSelection ? [] : [drawSelection(), codeSelection], bracketMatching({ brackets: matchingBrackets }), indentOnInput(), syntaxHighlighting(themeHighlightStyle), pairedSymbols, pairingCaret,
      // 桌面键盘用 closeBrackets 补齐成对符号；手机输入法不在编辑器内配对，改由 singleSymbolPairs 补齐。
      // closeBrackets 在桌面组合输入期间跳过，compositionBracketCompletion 只登记中文输入法提交的全角符号，
      // 等组合结束后再补：组合期间改写正文会与输入法写回的文本竞争，编辑器收不到组合结束就会停在组合态并吞掉按键。
      // bracketCompletion 为两者提供含全角符号的配对表，并让 Backspace 一次删除整对；
      // pairingCaret 抵消输入法回发把刚补齐的光标推到闭符号之后的行为。
      this.options.nativeSelection ? singleSymbolPairs : [compositionBracketCompletion, closeBrackets()], bracketCompletion,
      this.mode.of(this.modeExtensions(mode)),
      this.headingAdd.of(headingAddFacet.of(this.headingAddEnabled)),
      resourcesFacet.of(this.options),
      actionsFacet.of({ toggleTask: (from, group) => this.toggleTask(from, group), toggleFold: from => this.toggleFold(from), toggleCompletedGroup: from => this.toggleCompletedGroup(from), moveItem: (from, direction) => this.moveItem(from, direction), moveTo: (from, boundary) => this.moveTo(from, boundary), moveDrag: (kind, from, boundary) => this.moveDrag(kind, from, boundary), focusAt: from => this.focusAt(from), placeCaret: from => this.placeCaret(from), insertTaskAt: position => this.insertTaskAt(position), openCanvas: from => { this.canvasEditor.open(from); } }),
      documentField, canvasEditing, foldsField, expandedCompletedGroupsField, foldHistory, softBreaksField, softBreakHistory, draftFencedBlocksField, draftFencedBlockHistory, sourceScopeExtension, sourceReturnField, sourcePositionHistory, previewWindowField, revealViewport, contentVisibility, previewField, previewComposition, previewWindowPlugin, headingAddHover, markerGestures, foldMotion, syncArrivalExtension,
      keymap.of([...taskKeymap, ...closeBracketsKeymap, ...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      this.language.of(this.languageExtensions()),
      EditorView.updateListener.of(update => {
        this.canvasEditor?.update(update);
        // 焦点变化不会撤销剪贴板意图；真正改变目标或视图契约的事务必须关闭菜单。
        if (update.docChanged || !update.state.selection.eq(update.startState.selection)
          || update.transactions.some(transaction => transaction.reconfigured)) this.contextMenu?.invalidate();
        // 分段接收的中间帧不是用户编辑：不触发正文与界面回调，应用侧会话正文已按最终文本记录，
        // 逐帧回调会让保存、版本比较和折叠键匹配看到尚未写完的正文。
        if (update.docChanged && isSyncStreamUpdate(update)) return;
        if (update.docChanged) {
          // 用户或其他命令在接收过程中改动了正文：剩余差异按当时的正文重新计算后立即写入。
          this.stream.interrupt();
          this.options.onChange(update.state.doc.toString());
        }
        else if (update.state.field(expandedCompletedGroupsField) !== update.startState.field(expandedCompletedGroupsField)
          || update.state.field(foldsField) !== update.startState.field(foldsField)) this.options.onUIChange?.();
      }),
    ] });
  }

  /** 语言仅影响界面扩展；重配置保留正文、选区、折叠和历史，不触发正文保存。 */
  private languageExtensions(): Extension[] {
    return [placeholder(translate('写下第一件事，或输入 - [ ] 创建任务…')), EditorView.contentAttributes.of({ 'aria-label': translate('Markdown 任务文档'), spellcheck: 'false' })];
  }
  private refreshLanguage(): void {
    // 保留待确认操作及其事件绑定，只更新本控制器拥有的提示节点。
    if (this.groupPrompt) {
      this.groupPrompt.children[0].textContent = translate('还有未完成子任务');
      this.groupPrompt.children[1].textContent = translate('完成整组');
      this.groupPrompt.children[2].textContent = translate('取消');
    }
    this.view.dispatch({ effects: this.language.reconfigure(this.languageExtensions()), annotations: Transaction.addToHistory.of(false) });
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
    this.contextMenu?.invalidate();
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

  /** 切换标题下新增任务入口；仅重配置界面扩展，不写正文历史或折叠状态。 */
  setHeadingAddEnabled(enabled: boolean): void {
    if (this.headingAddEnabled === enabled) return;
    this.headingAddEnabled = enabled;
    this.view.dispatch({ effects: this.headingAdd.reconfigure(headingAddFacet.of(enabled)), annotations: Transaction.addToHistory.of(false) });
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
      ? translate('暂缓整理归档：请检查源码中的代码围栏或 HTML 是否完整。') : null;
  }

  /**
   * 函数职责：接收对端版本并替换当前正文。
   * 输入说明：text 为合并后的完整文档；settled 在目标文本全部落到视图后调用，用于刷新应用侧的会话正文；
   * 组合输入期间拒绝执行。
   * 输出说明：按差异区间分段写入并恢复阅读锚点，折叠状态按折叠键保留；接收内容不进入撤销历史。
   * 实现思路：首段同步写入保证接收立即生效，其余差异逐帧写入，避免整篇在同一帧内跳变。
   */
  setSynchronizedText(text: string, settled?: () => void): void {
    if (this.view.composing) throw new Error('SYNC_BUSY: 正在组合输入');
    this.contextMenu?.invalidate();
    this.pendingSettle = settled;
    this.stream.run(text);
  }

  /**
   * 函数职责：分段写入落定后重新对齐界面状态。
   * 输入说明：无；折叠键只能在最终正文上匹配，中途各帧按位置映射的折叠会落到相邻条目。
   * 输出说明：不写像素滚动；补做分段期间跳过的归档整理，再按界面状态恢复折叠与选区。
   */
  private settleSynchronizedText(): void {
    // 分段写入为了保持后续差异坐标有效而关闭了事务过滤，归档整理改在这里按最终正文补一次；
    // 整理结果进入正文回调，由保存流程写入磁盘，与外部修改后的处理方式一致。
    if (this.state.facet(modeFacet) !== 'source') {
      const layout = archiveLayoutSpec(this.state);
      if (layout) this.view.dispatch({ ...layout, annotations: Transaction.addToHistory.of(false), filter: false });
    }
    this.applyUIState(this.getUIState(), false);
    const settled = this.pendingSettle;
    this.pendingSettle = undefined;
    settled?.();
  }

  /** 外部全文替换只恢复可可靠匹配的折叠键，避免位置复用误折叠另一条目。 */
  setText(text: string, resetHistory = false): void {
    this.canvasEditor.invalidate();
    this.stream.abandon();
    this.pendingSettle = undefined;
    this.contextMenu?.invalidate();
    this.positionGeneration++;
    const ui = this.getUIState();
    if (resetHistory) { this.view.setState(this.createState(text, ui.mode)); this.setUIState(ui); return; }
    this.view.dispatch({ changes: { from: 0, to: this.state.doc.length, insert: text }, effects: refreshSourceScope.of(null), annotations: isolateHistory.of('full') });
    this.setUIState(ui);
  }
  restoreState(state: EditorState, ui?: ProjectView): void {
    this.canvasEditor.invalidate();
    // 单一视图跨项目复用，即使恢复同一状态对象，也必须取消此前项目的异步剪贴板动作。
    // 未写完整的分段接收随旧状态一起丢弃，应用侧正文已在接收时按最终文本记录。
    this.stream.abandon();
    this.pendingSettle = undefined;
    this.contextMenu?.invalidate();
    this.positionGeneration++;
    this.closeGroupPrompt(); this.view.setState(state);
    // 后台项目保存的状态可能来自旧语言；复用其历史后再同步当前界面语言。
    this.refreshLanguage();
    if (ui) this.setUIState(ui);
    // 后台项目保存的状态可能带着旧的入口开关值；恢复后立即对齐当前设置。
    if (this.view.state.facet(headingAddFacet) !== this.headingAddEnabled)
      this.view.dispatch({ effects: this.headingAdd.reconfigure(headingAddFacet.of(this.headingAddEnabled)), annotations: Transaction.addToHistory.of(false) });
  }
  getUIState(): ProjectView {
    const model = this.state.field(documentField);
    const folded = [...this.state.field(foldsField)].flatMap(from => { const item = model.items.find(item => item.from === from); const key = item ? foldKey(model, item) : ''; return key ? [key] : []; });
    const mode = this.state.facet(modeFacet);
    const sourceReturn = this.state.field(sourceReturnField);
    const expandedCompletedGroups = [...this.state.field(expandedCompletedGroupsField)].flatMap(from => {
      const item = model.items.find(item => item.from === from); const key = item ? foldKey(model, item) : ''; return key ? [key] : [];
    });
    return { mode, cursor: this.state.selection.main.head, scrollTop: this.view.scrollDOM.scrollTop, folded,
      ...(expandedCompletedGroups.length ? { expandedCompletedGroups } : {}),
      ...(mode === 'source' ? { sourceView: this.state.facet(sourceViewFacet), ...(sourceReturn ? { sourceReturn } : {}) } : {}),
    };
  }
  setUIState(ui: ProjectView): void { this.applyUIState(ui, true); }

  /**
   * 函数职责：应用持久化的界面状态。
   * 输入说明：restoreScroll 为真时才按 ui.scrollTop 写像素滚动，仅适用于布局已稳定的项目切换；
   * 接收同步的位置必须由语义锚点恢复，写回替换前的像素值会落到错误位置。
   */
  private applyUIState(ui: ProjectView, restoreScroll: boolean): void {
    this.contextMenu?.invalidate();
    this.positionGeneration++;
    const model = this.state.field(documentField);
    const keys = new Set(ui.folded.filter(Boolean));
    const folded = keys.size ? model.items.filter(item => keys.has(foldKey(model, item))).map(item => item.from) : [];
    const groupKeys = new Set(ui.expandedCompletedGroups ?? []);
    const expandedGroups = model.items.filter(item => groupKeys.has(foldKey(model, item))).map(item => item.from);
    const sourceReturn = ui.sourceReturn ? { ...ui.sourceReturn, cursor: Math.min(ui.sourceReturn.cursor, this.state.doc.length), anchor: Math.min(ui.sourceReturn.anchor, this.state.doc.length) } : null;
    this.view.dispatch({ selection: { anchor: Math.max(0, Math.min(ui.cursor, this.state.doc.length)) }, effects: [this.mode.reconfigure(this.modeExtensions(ui.mode, ui.sourceView ?? (ui.mode === 'archive' ? 'archive' : 'todo'))), setFolds.of(folded), setExpandedCompletedGroups.of(expandedGroups), setSourceReturn.of(ui.mode === 'source' ? sourceReturn : null)], annotations: Transaction.addToHistory.of(false) });
    if (restoreScroll) this.view.scrollDOM.scrollTop = ui.scrollTop;
  }
  /**
   * 搜索、大纲及空内容点击的唯一居中定位入口：展开目标后从当前视口平滑滚动到居中位置。
   * 其他正文内点击使用 placeCaret，避免可见控件再次推动页面。
   */
  focusAt(pos: number): void {
    this.positionGeneration++;
    const anchor = Math.max(0, Math.min(pos, this.state.doc.length));
    const model = this.state.field(documentField);
    const folds = [...this.state.field(foldsField)].filter(from => { const item = model.items.find(item => item.from === from); return !item || anchor <= item.firstLineTo || anchor > item.to; });
    const expandedGroups = new Set(this.state.field(expandedCompletedGroupsField));
    for (const group of completedChildGroups(model)) if (anchor >= group.from && anchor < group.to) expandedGroups.add(group.parentFrom!);
    const window = this.state.field(previewWindowField);
    const viewportEffect = anchor < window.from || anchor > window.to ? [setPreviewWindow.of({ from: Math.max(0, anchor - 3000), to: Math.min(this.state.doc.length, anchor + 3000) })] : [];
    this.view.dispatch({ selection: { anchor }, effects: [setFolds.of(folds), setExpandedCompletedGroups.of([...expandedGroups]), ...viewportEffect, EditorView.scrollIntoView(anchor, { y: 'center' })], annotations: Transaction.addToHistory.of(false) });
    this.view.focus();
  }
  /** 正文内的预览控件点击后落点已可见，只需放置光标，滚动或重排会把页面推离当前位置。 */
  placeCaret(pos: number): void {
    const anchor = Math.max(0, Math.min(pos, this.state.doc.length));
    this.view.dispatch({ selection: { anchor }, annotations: Transaction.addToHistory.of(false) });
    this.view.focus();
  }
  insertTask(): void {
    if (this.state.facet(modeFacet) === 'archive' || this.state.facet(sourceViewFacet) === 'archive') this.setMode('todo');
    const { state, model } = this;
    const cursor = state.selection.main.head;
    const line = state.doc.lineAt(cursor);
    const layout = paragraphLayout(state);
    const paragraph = layout.paragraphs[paragraphAt(layout, cursor)];
    let position = line.to;
    let indent = '';
    const emptyLine = !line.text.trim() && paragraph?.kind !== 'literal';
    if (!emptyLine) {
      // 菜单失焦不改变编辑器选区；使用最内层完整条目，避免把其正文或子任务拆给新任务。
      const item = model.items.filter(item => cursor >= item.from && cursor <= item.to).at(-1);
      if (item) {
        position = item.moveTo;
        indent = state.doc.sliceString(state.doc.lineAt(item.from).from, item.markerFrom);
      } else {
        position = Math.min(state.doc.length, state.doc.lineAt(paragraph?.to ?? cursor).to + 1);
      }
    }
    this.writeTaskInsert(position, indent, emptyLine);
  }
  /** 在当前段落的同一容器插入空画布；完整快照写入与打开由局部会话协调。 */
  insertCanvas(): boolean { return this.canvasEditor.insert(); }
  /** 在标题块后的可见行边界插入空任务；锚点由预览控件按同一布局规则计算。 */
  insertTaskAt(position: number): void {
    if (this.state.facet(modeFacet) === 'archive' || this.state.facet(sourceViewFacet) === 'archive') this.setMode('todo');
    this.writeTaskInsert(Math.min(position, this.state.doc.length), '');
  }
  /**
   * 落点若被隐藏分区包含则收敛到可见边界；空行配对保证新任务不吞并后续正文或列表。
   * reuseLine 表示落点在空白行自身的缩进之后（光标路径的空行），必须原位续接，不加换行前缀。
   */
  private writeTaskInsert(position: number, indent: string, reuseLine = false): void {
    const { state } = this;
    const hiddenRanges = state.facet(modeFacet) === 'source' ? state.field(sourceScopeField) : getHiddenRanges(this.model, 'todo');
    const hidden = hiddenRanges.find(range => position > range.from && position <= range.to);
    if (hidden) { position = hidden.from; indent = ''; }
    // 落点不在行首时先换行，让新任务独占源码行。
    const prefix = !reuseLine && position && state.doc.sliceString(position - 1, position) !== '\n' ? '\n' : '';
    const taskLineFrom = reuseLine ? state.doc.lineAt(position).from : position + prefix.length;
    const insert = `${prefix}${indent}- [ ] `;
    const followingBreaks = /^\n*/.exec(state.doc.sliceString(position, position + 2))![0].length;
    const suffix = position < state.doc.length ? '\n'.repeat(Math.max(0, 2 - followingBreaks)) : '';
    // 新任务自成段落。落点若落在某段的软续行（段内换行）内，任务行会被读成上一段的内容，
    // 渲染时多出一行；此时在任务行前补断行，把上一段与新任务分成两段。
    const glued = taskLineFrom > 0 && !!state.field(softBreaksField, false)?.includes(taskLineFrom - 1);
    const changes = glued && taskLineFrom !== position
      ? [{ from: taskLineFrom, insert: '\n' }, { from: position, insert: insert + suffix }]
      : { from: position, insert: `${glued ? '\n' : ''}${insert}${suffix}` };
    // 任务行行首的换行不能再标记为上一段的软续行；否则该身份会残留到之后的段落编辑里，
    // 把新分隔空行解码成软续行，渲染时多出一行。
    const breaks = taskLineFrom > 0 ? revalidateSoftBreaks(state, changes, pos => pos === taskLineFrom - 1) : null;
    this.view.dispatch({ changes, selection: { anchor: position + insert.length + (glued ? 1 : 0) }, annotations: isolateHistory.of('full'), effects: breaks ? [breaks] : undefined, scrollIntoView: true });
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
      const mapping = this.state.changes(changes);
      // 控件操作结束文本选择；隐藏当前任务时迁移光标，否则保留原选区活动端的编辑位置。
      const selection = { anchor: mapping.mapPos(!item.task.checked && anchorInside ? next?.contentFrom ?? model.text.length : current.head) };
      const completing = group || !item.task.checked;
      const expanded = new Set<number>();
      if (!completing) {
        // 恢复项及全部祖先必须展开，防止已归档树的自动折叠继续遮住重新开放的子任务。
        const byFrom = new Map(model.items.map(entry => [entry.from, entry]));
        for (let ancestor: number | null = item.from; ancestor !== null; ancestor = byFrom.get(ancestor)!.parentFrom) expanded.add(ancestor);
      }
      const effects = expanded.size ? setFolds.of([...this.state.field(foldsField)].filter(from => !expanded.has(from)).map(from => mapping.mapPos(from, 1))) : undefined;
      this.view.dispatch({ changes, selection, effects, annotations: isolateHistory.of('full'), userEvent: 'input.complete' });
      this.closeGroupPrompt();
      this.options.onStatus?.(this.archiveLayoutWarning() ?? (completing ? group ? translate('整组已完成，可撤销') : translate('任务已完成，可撤销') : translate('任务已恢复，可撤销')));
    } catch (error) {
      if (error instanceof Error && error.message.includes('TASK_GROUP_REQUIRED')) {
        // 尚未完成整组也已激活任务控件；只清除选区，正文和撤销历史保持不变。
        this.view.dispatch({ selection: { anchor: this.state.selection.main.head }, annotations: Transaction.addToHistory.of(false) });
        this.showGroupPrompt(itemFrom); return;
      }
      this.options.onStatus?.(error instanceof Error ? error.message : translate('任务操作失败'));
    }
  }

  private showGroupPrompt(from: number): void {
    this.closeGroupPrompt();
    const prompt = document.createElement('div'); prompt.className = 'fm-group-prompt'; prompt.setAttribute('role', 'status');
    const label = document.createElement('span'); label.textContent = translate('还有未完成子任务');
    const complete = document.createElement('button'); complete.textContent = translate('完成整组'); complete.onclick = () => this.toggleTask(from, true);
    const cancel = document.createElement('button'); cancel.textContent = translate('取消'); cancel.onclick = () => this.closeGroupPrompt();
    prompt.append(label, complete, cancel); this.view.dom.append(prompt); this.groupPrompt = prompt;
    // 捕获下一次按下，避免被触发本提示的 click 立即关闭，也避免正文阻止冒泡后漏掉外部操作。
    window.addEventListener('pointerdown', this.dismissGroupPrompt, true);
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

  /** 移动的选区与折叠使用原条目内部位移；其他坐标使用标准事务映射，视图不跟随条目滚动。 */
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
      const expandedGroups = [...this.state.field(expandedCompletedGroupsField)].map(map);
      this.view.dispatch({ changes, selection, effects: [setFolds.of(folds), setExpandedCompletedGroups.of(expandedGroups)], annotations: isolateHistory.of('full'), userEvent: 'move' });
    } catch (error) { this.options.onStatus?.(error instanceof Error ? error.message : translate('无法移动条目')); }
  }

  /** 拖动落点统一入口；条目子树与画布围栏各自使用对应的正文事务。 */
  private moveDrag(kind: DragKind, from: number, boundary: number | null): void {
    if (kind === 'canvas') this.moveCanvas(from, boundary);
    else this.moveTo(from, boundary);
  }

  /** 画布整块移动与任务拖动共用指针入口；失效落点静默忽略，异常沿用状态栏反馈。 */
  private moveCanvas(from: number, boundary: number | null): void {
    if (this.state.facet(modeFacet) !== 'todo') return;
    try { moveCanvasBlock(this.view, from, boundary); }
    catch (error) { this.options.onStatus?.(error instanceof Error ? error.message : translate('无法移动画布')); }
  }

  toggleFold(itemFrom: number): void {
    const item = this.state.field(documentField).items.find(item => item.from === itemFrom);
    if (!item || item.to <= item.firstLineTo) return;
    const folds = new Set(this.state.field(foldsField));
    const willFold = !folds.has(itemFrom);
    if (willFold) folds.add(itemFrom); else folds.delete(itemFrom);
    const selection = this.state.selection.main;
    const intersects = selection.to > item.firstLineTo && selection.from < item.to;
    // 展开与收起都结束文本选择；收起遮住原选区时才把光标移到父行末尾。
    const change = () => this.view.dispatch({ effects: setFolds.of([...folds]), selection: { anchor: willFold && intersects ? item.firstLineTo : selection.head }, annotations: Transaction.addToHistory.of(false) });
    const motion = this.view.plugin(foldMotion);
    if (motion) motion.run(change, willFold ? { from: item.firstLineTo + 1, to: item.to } : undefined); else change();
  }
  /**
   * 函数职责：切换父项下已完成子任务组的展开状态。
   * 输入说明：parentFrom 属于当前模型，源码模式使用完整可见源文，不响应组折叠。
   * 输出说明：只影响界面并清除文本选择，收起时将位于组内的选区移到可见边界，不写文本历史。
   * 实现思路：使用独立完成组字段，复用共享范围投影和条目内容身份。
   */
  toggleCompletedGroup(parentFrom: number): void {
    if (this.state.facet(modeFacet) === 'source') return;
    const groups = completedChildGroups(this.model).filter(group => group.parentFrom === parentFrom);
    if (!groups.length) return;
    const expanded = new Set(this.state.field(expandedCompletedGroupsField));
    const collapsing = expanded.has(parentFrom);
    if (collapsing) expanded.delete(parentFrom); else expanded.add(parentFrom);
    const selected = this.state.selection.main;
    const hidden = collapsing ? groups.find(group => selected.to > group.from && selected.from < group.to) : undefined;
    const parent = this.model.items.find(item => item.from === parentFrom)!;
    this.view.dispatch({ effects: setExpandedCompletedGroups.of([...expanded]), selection: { anchor: hidden ? parent.firstLineTo : selected.head }, annotations: Transaction.addToHistory.of(false) });
  }
  /** 用户开始滚动或编辑后，旧的异步切换测量不能抢回阅读位置。 */
  private cancelPositionRestore = (): void => { this.positionGeneration++; };
  destroy(): void {
    this.canvasEditor.invalidate();
    this.streamInstance?.destroy();
    this.pendingSettle = undefined;
    this.contextMenu?.destroy();
    this.unsubscribeLocale();
    this.positionGeneration++; this.closeGroupPrompt();
    this.view.dom.removeEventListener('keydown', this.historyKey, true);
    this.view.dom.removeEventListener('keydown', this.cancelPositionRestore, true);
    this.view.scrollDOM.removeEventListener('wheel', this.cancelPositionRestore);
    this.view.scrollDOM.removeEventListener('pointerdown', this.cancelPositionRestore);
    this.view.destroy();
  }
}
