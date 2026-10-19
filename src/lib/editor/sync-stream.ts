/**
 * 文件职责：把同步接收到的正文差异分段写入编辑视图。
 * 定义范围：差异分批规则、逐帧事务派发、到达高亮与中断收尾；不决定接收内容、保存状态与应用界面。
 */
import { Annotation, StateEffect, StateField, Transaction, type ChangeSet, type EditorState, type Extension, type Range, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { diffChars } from 'diff';
import { refreshSourceScope } from './source-scope';

/** 字符级差异：from/to 属于替换前的正文，insert 为替换后的文本。 */
export interface SyncEdit { from: number; to: number; insert: string }

/** 分段呈现的最多批次：批次越多，派发事务的总耗时越长。 */
const MAX_STEPS = 8;
/** 整段呈现的目标时长：批次按时间铺开，节奏不随显示器刷新率与批次数变化。 */
const REVEAL_DURATION = 160;
/** 批次之间的最短间隔：再短就与一次写入无法区分。 */
const MIN_STEP_INTERVAL = 12;
/** 单处插入达到该行数才按行组拆分；短改动一次写入，不做无意义的等待。 */
const REVEAL_MIN_LINES = 4;
/** 行组的目标行数：长插入按此节奏依次出现。 */
const LINES_PER_GROUP = 3;
/** 单处插入最多拆成的行组数量，避免超长插入把正文拆成细碎事务。 */
const MAX_LINE_GROUPS = 6;
/** 单行插入的呈现块数上限：短句按单字出现，长句均分到固定块数，总时长不随长度增长。 */
const MAX_CHAR_GROUPS = 8;
/** 少于该字符数的插入一次写入，拆开只会闪烁。 */
const MIN_REVEAL_CHARS = 4;
/** 到达高亮最多标注的行数，超出部分不再错开延迟。 */
const MAX_ARRIVAL_LINES = 60;
/** 相邻到达行的延迟步长与最多错开的步数，总时长控制在一次短暂过渡内。 */
const ARRIVAL_STEP = 40;
const ARRIVAL_STAGGER = 6;
/** 到达高亮的保留时长：覆盖背景过渡本身，收尾后统一清除。 */
const ARRIVAL_LIFETIME = 720;

/** 分段接收的事务标记：更新监听据此区分接收内容与用户编辑。 */
export const syncStreamTransaction = Annotation.define<boolean>();

/** 该次更新是否完全由分段接收写入构成。 */
export function isSyncStreamUpdate(update: ViewUpdate): boolean {
  return update.transactions.length > 0 && update.transactions.every(transaction => transaction.annotation(syncStreamTransaction) === true);
}

/**
 * 函数职责：把两段文本的字符级差异转成编辑区间。
 * 输入说明：current 为视图当前正文，target 为目标正文。
 * 输出说明：区间按位置升序且互不重叠；差异过大或超时退化为全文替换。
 */
export function diffEdits(current: string, target: string): SyncEdit[] {
  if (current === target) return [];
  const parts = diffChars(current, target, { timeout: 100, maxEditLength: 10000 });
  if (!parts) return [{ from: 0, to: current.length, insert: target }];
  const edits: SyncEdit[] = [];
  let offset = 0;
  for (const part of parts) {
    if (part.removed) { edits.push({ from: offset, to: offset + part.value.length, insert: '' }); offset += part.value.length; }
    else if (part.added) edits.push({ from: offset, to: offset, insert: part.value });
    else offset += part.value.length;
  }
  return edits;
}

/**
 * 函数职责：把差异划分为逐帧写入的批次。
 * 输入说明：edits 按位置升序且互不重叠；anchor 为阅读位置所在正文位置，null 表示正文未超出视口；
 *   text 为写入前的正文，用于判断插入点是否落在行首。
 * 输出说明：首个批次承载阅读位置及其上方的全部差异，其余批次按位置递增写入阅读位置下方的内容。
 * 实现思路：先按行组或字符块拆开插入，再把相邻差异平分为不超过 MAX_STEPS 批。
 * 边界条件：阅读位置及以上方的差异无法逐帧呈现——这些变化在视口之外，逐帧写入看不到过程，
 *   行内增长还会让每帧的滚动对齐读到过期的行高，锚点行会短暂偏移一帧；因此与首个批次一次写入，
 *   后续批次只写入阅读位置下方的插入内容。
 */
export function planSyncSteps(edits: readonly SyncEdit[], anchor: number | null = null, text = ''): SyncEdit[][] {
  const immediate = anchor === null ? [] : edits.filter(edit => edit.from <= anchor);
  const staged = edits.filter(edit => !immediate.includes(edit));
  const units: { edit: SyncEdit; split: number }[] = [];
  staged.forEach((edit, index) => {
    const pieces = revealPieces(edit, text);
    // 拆开的长插入必须逐个批次写入：同一批差异共用替换前的坐标，
    // 而同一位置的多段插入只有前一段写入后，后一段的坐标才成立。
    for (const piece of pieces) units.push({ edit: piece, split: pieces.length > 1 ? index : -1 });
  });
  if (!units.length && !immediate.length) return [];
  const perStep = Math.ceil(units.length / Math.max(1, MAX_STEPS - (immediate.length ? 1 : 0)));
  const steps: SyncEdit[][] = [];
  let current: SyncEdit[] = [];
  let previousSplit = -1;
  for (const unit of units) {
    if (current.length && (current.length >= perStep || unit.split >= 0 && unit.split === previousSplit)) { steps.push(current); current = []; }
    current.push(unit.edit);
    previousSplit = unit.split;
  }
  if (current.length) steps.push(current);
  if (immediate.length) steps.unshift(immediate);
  return steps;
}

/** 插入内容按行组或字符块切开后逐个出现，切出的各段都落在同一插入点；删除保持完整。 */
function revealPieces(edit: SyncEdit, text: string): SyncEdit[] {
  if (edit.to !== edit.from || !edit.insert) return [edit];
  const lines = linePieces(edit.insert);
  if (lines.length > 1) return lines.map(insert => ({ from: edit.from, to: edit.from, insert }));
  if (edit.insert.length < MIN_REVEAL_CHARS) return [edit];
  // 只有行内插入可以逐字出现：行首插入或带换行的插入会改写这一行的前缀（标题、任务、围栏），
  // 逐块出现时结构先降级再恢复，行高在中间帧变化，阅读位置随之跳动。
  if (edit.insert.includes('\n') || edit.from === 0 || text.charCodeAt(edit.from - 1) === 10) return [edit];
  return charPieces(edit.insert).map(insert => ({ from: edit.from, to: edit.from, insert }));
}

/** 达到 REVEAL_MIN_LINES 行的插入按行组切开；更短的插入整段返回，交由字符块继续拆分。 */
function linePieces(insert: string): string[] {
  const breaks: number[] = [];
  for (let index = 0; index < insert.length; index++) if (insert.charCodeAt(index) === 10) breaks.push(index + 1);
  const lines = breaks.length + (breaks[breaks.length - 1] === insert.length ? 0 : 1);
  if (lines < REVEAL_MIN_LINES) return [insert];
  const groups = Math.min(MAX_LINE_GROUPS, Math.ceil(lines / LINES_PER_GROUP));
  const perGroup = Math.ceil(breaks.length / groups);
  const endOfGroup = (group: number): number => {
    const boundary = (group + 1) * perGroup;
    return boundary >= breaks.length ? insert.length : breaks[boundary - 1];
  };
  const pieces: string[] = [];
  let start = 0;
  for (let group = 0; group < groups; group++) {
    const end = endOfGroup(group);
    if (end > start) pieces.push(insert.slice(start, end));
    start = end;
  }
  if (start < insert.length) pieces.push(insert.slice(start));
  return pieces;
}

/** 单行插入按字符切块：短句逐字出现，长句均分到固定块数；切点避开代理对，中间帧不会出现半个字符。 */
function charPieces(insert: string): string[] {
  const groups = Math.min(MAX_CHAR_GROUPS, insert.length);
  const perGroup = Math.ceil(insert.length / groups);
  const pieces: string[] = [];
  let start = 0;
  while (start < insert.length) {
    let end = Math.min(insert.length, start + perGroup);
    const last = insert.charCodeAt(end - 1);
    if (end < insert.length && last >= 0xd800 && last <= 0xdbff) end += 1;
    pieces.push(insert.slice(start, end));
    start = end;
  }
  return pieces;
}

/** 到达高亮范围使用写入后的正文坐标。 */
interface SyncArrivalRange { from: number; to: number }

/** 当前到达高亮；null 立即清除，正文变化时随差异映射。 */
const setSyncArrival = StateEffect.define<readonly SyncArrivalRange[] | null>();

/** 按行渲染的到达高亮只改变底色，不改变行高与盒模型，逐帧写入时布局保持稳定。 */
const syncArrivalField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setSyncArrival)) continue;
      return effect.value?.length ? arrivalDecorations(transaction.state, effect.value) : Decoration.none;
    }
    return transaction.docChanged ? value.map(transaction.changes) : value;
  },
  provide: field => EditorView.decorations.from(field),
});

export const syncArrivalExtension: Extension = syncArrivalField;

function arrivalDecorations(state: EditorState, ranges: readonly SyncArrivalRange[]): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const seen = new Set<number>();
  for (const range of ranges) {
    const first = state.doc.lineAt(Math.min(range.from, state.doc.length));
    const last = state.doc.lineAt(Math.min(range.to, state.doc.length));
    for (let number = first.number; number <= last.number; number++) {
      if (seen.has(number) || seen.size >= MAX_ARRIVAL_LINES) continue;
      seen.add(number);
      // 延迟只影响颜色过渡；错开步数有上限，长段插入不会排队到动画结束之后。
      decorations.push(Decoration.line({ class: 'fm-sync-arrival', attributes: { style: `--fm-sync-delay:${Math.min(seen.size - 1, ARRIVAL_STAGGER) * ARRIVAL_STEP}ms` } }).range(state.doc.line(number).from));
    }
  }
  return Decoration.set(decorations, true);
}

/**
 * 接口职责：分段接收落定后的交接端口。
 * 调用方：编辑器控制器恢复界面状态、整理布局并通知应用刷新会话正文。
 * 约束条件：只在目标文本全部写入视图后调用，被整份替换中断时不调用。
 */
export interface SyncStreamHost { settled(): void }

/** 分段呈现的前提：有帧调度能力且用户未要求减少动态效果；缺少帧调度的环境一次写入全部差异。 */
function canAnimate(view: EditorView): boolean {
  const win = view.dom.ownerDocument.defaultView;
  if (!win || typeof win.requestAnimationFrame !== 'function') return false;
  return !(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}

/** 呈现计时所用的单调时钟，避免系统时间调整影响批次间隔。 */
function now(view: EditorView): number {
  return view.dom.ownerDocument.defaultView?.performance.now() ?? Date.now();
}

/**
 * 接口职责：为一次接收分段写入正文并标注到达行。
 * 调用方：编辑器控制器的同步接收入口。
 * 实现要求：首个批次同步写入，其余批次按固定总时长铺开；用户编辑立即落定剩余差异；整份替换放弃剩余分段。
 */
export class SyncStream {
  private steps: readonly (readonly SyncEdit[])[] = [];
  private index = 0;
  /** 已写入差异的位置与长度变化，把未写入差异的原始坐标换到当前正文。 */
  private applied: { at: number; shift: number }[] = [];
  private target = '';
  /** 整段接收期间的阅读位置：null 表示正文未超出视口，无需保护。 */
  private anchor: number | null = null;
  private arrivals: SyncArrivalRange[] = [];
  /** 下一次写入的计时器；批次按时间推进而不是按帧计数。 */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 本次呈现的起始时刻与批次间隔。 */
  private startedAt = 0;
  private interval = 0;
  private arrivalsTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private deferred = false;
  private streaming = false;
  private alive = true;

  constructor(private readonly view: EditorView, private readonly host: SyncStreamHost) {}

  /**
   * 函数职责：把当前正文写入目标文本。
   * 输入说明：target 为合并后的完整文档；已有分段被最新目标取代，已写入的部分保留。
   * 输出说明：全部落定后调用 host.settled；正文已一致时不派发事务。
   */
  run(target: string): void {
    if (!this.alive) return;
    this.cancel();
    this.generation++;
    this.target = target;
    this.arrivals = [];
    this.applied = [];
    const edits = diffEdits(this.text, target);
    if (!edits.length) { this.host.settled(); return; }
    this.captureAnchor();
    if (!canAnimate(this.view)) { this.apply(this.view.state.changes(edits), []); this.host.settled(); return; }
    this.steps = planSyncSteps(edits, this.anchor, this.text);
    this.index = 0; this.streaming = true;
    // 批次数只决定写入间隔，整段时长固定在 REVEAL_DURATION 附近。
    this.startedAt = now(this.view);
    this.interval = Math.max(MIN_STEP_INTERVAL, REVEAL_DURATION / Math.max(1, this.steps.length));
    this.write();
  }

  /**
   * 函数职责：在分段写入期间出现用户编辑时立即落定剩余差异。
   * 输入说明：无；由更新监听同步调用，此时不允许派发事务。
   * 输出说明：延后到微任务一次性写完全部剩余差异，坐标按当时的正文重新计算。
   */
  interrupt(): void {
    if (!this.streaming || this.deferred) return;
    this.deferred = true;
    queueMicrotask(() => { this.deferred = false; this.finish(); });
  }

  /** 放弃剩余分段：正文即将被整份替换或视图即将销毁，未写入的差异不再需要。 */
  abandon(): void {
    this.generation++;
    this.cancel();
    this.streaming = false;
    this.steps = []; this.index = 0;
    this.arrivals = [];
    this.applied = [];
    this.anchor = null;
    if (this.alive && this.view.state.field(syncArrivalField, false)?.size) this.dispatchArrival(null);
  }

  /** 视图销毁：丢弃未写入的差异与已排队的帧和收尾计时器。 */
  destroy(): void {
    this.alive = false;
    this.cancel();
    this.streaming = false;
    this.steps = []; this.index = 0;
    this.arrivals = [];
    this.applied = [];
    this.anchor = null;
  }

  private get text(): string { return this.view.state.doc.toString(); }

  private write(): void {
    const batch = this.steps[this.index++] ?? [];
    const edits: SyncEdit[] = [];
    const arrivals: SyncArrivalRange[] = [];
    for (const edit of batch) {
      const from = this.position(edit.from);
      edits.push({ from, to: this.position(edit.to), insert: edit.insert });
      if (edit.insert) arrivals.push({ from, to: from + edit.insert.length });
    }
    for (const edit of batch) this.applied.push({ at: edit.from, shift: edit.insert.length - (edit.to - edit.from) });
    this.apply(this.view.state.changes(edits), arrivals);
    if (this.index < this.steps.length) this.schedule();
    else this.settle();
  }

  /** 把基准正文位置换到当前正文：同一插入点上的多段插入按已写入顺序依次落在后面。 */
  private position(position: number): number {
    let shift = 0;
    for (const entry of this.applied) if (entry.at <= position) shift += entry.shift;
    return position + shift;
  }

  /** 记录阅读位置所在正文位置，用于决定哪些差异必须与首个批次同时写入。 */
  private captureAnchor(): void {
    const dom = this.view.scrollDOM;
    const snapshot = dom.scrollHeight <= dom.clientHeight ? undefined : this.view.scrollSnapshot();
    this.anchor = snapshot ? snapshot.value.range.head : null;
  }

  private apply(changes: ChangeSet, arrivals: readonly SyncArrivalRange[]): void {
    // 已标注的行随正文变化映射，本帧新增范围追加在后面：到达高亮跨帧保留，不随写入顺序错位。
    this.arrivals = this.arrivals.map(range => {
      const from = changes.mapPos(range.from, 1);
      return { from, to: Math.max(from, changes.mapPos(range.to, -1)) };
    }).concat(arrivals).slice(-MAX_ARRIVAL_LINES);
    const effects: StateEffect<unknown>[] = [refreshSourceScope.of(null)];
    // 每个中间帧都要重算源码可见范围，否则后续帧会沿用上一份正文的隐藏坐标；
    // 滚动位置随本帧差异映射，接收差异不让阅读位置移动。
    const snapshot = this.view.scrollSnapshot();
    const scroll = snapshot?.map(changes);
    if (scroll) effects.push(scroll);
    effects.push(setSyncArrival.of(this.arrivals));
    const spec: TransactionSpec = {
      changes,
      effects,
      // 接收内容不进入撤销历史；跳过分段写入时的事务过滤：
      // 归档整理会搬移正文，使后续批次按原坐标计算的位置失效。
      annotations: [Transaction.addToHistory.of(false), syncStreamTransaction.of(true)],
      filter: false,
    };
    this.view.dispatch(spec);
  }

  private dispatchArrival(arrivals: readonly SyncArrivalRange[] | null): void {
    if (!this.alive) return;
    this.view.dispatch({ effects: setSyncArrival.of(arrivals) });
  }

  private schedule(): void {
    // 按目标时刻推进而不是每帧推进一批：帧间隔取决于显示器刷新率，高刷新率屏幕上
    // “每帧一步”会让整段只有几十毫秒，60Hz 屏幕上又慢一倍；固定总时长后各设备节奏一致。
    const wait = Math.max(0, this.startedAt + this.index * this.interval - now(this.view));
    this.timer = setTimeout(() => { this.timer = undefined; this.write(); }, wait);
  }

  private settle(): void {
    this.streaming = false;
    this.steps = []; this.index = 0;
    this.host.settled();
    this.scheduleArrivalClear();
  }

  private finish(): void {
    if (!this.streaming) return;
    this.cancel();
    this.streaming = false;
    this.steps = []; this.index = 0;
    const remaining = diffEdits(this.text, this.target);
    this.applied = [];
    if (remaining.length) {
      // 中断时正文已被用户改动，锚点要按当前布局重新取样再写入剩余差异。
      this.captureAnchor();
      this.apply(this.view.state.changes(remaining), []);
    }
    this.settle();
  }

  private scheduleArrivalClear(): void {
    if (!this.arrivals.length) return;
    const generation = this.generation;
    this.arrivalsTimer = setTimeout(() => {
      this.arrivalsTimer = undefined;
      if (generation !== this.generation || !this.alive) return;
      this.arrivals = [];
      this.dispatchArrival(null);
    }, ARRIVAL_LIFETIME);
  }

  private cancel(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.arrivalsTimer !== undefined) { clearTimeout(this.arrivalsTimer); this.arrivalsTimer = undefined; }
  }
}
