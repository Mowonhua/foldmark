/**
 * 文件职责：定义成对符号表，并处理输入时的自动补齐与光标居中。
 * 定义范围：符号表、单个开符号补齐、桌面组合输入补齐、输入法整对提交居中、closeBrackets 与成对高亮的配对配置。
 */
import { insertBracket } from '@codemirror/autocomplete';
import { CharCategory, EditorState, Prec, Transaction, codePointAt, codePointSize } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** 开符号到闭符号的映射，半角符号与对应的全角、中文符号成对收录。 */
const OPENINGS: ReadonlyMap<string, string> = new Map([
  ['(', ')'], ['[', ']'], ['{', '}'], ['<', '>'], ['"', '"'], ["'", "'"],
  ['（', '）'], ['［', '］'], ['｛', '｝'], ['〈', '〉'], ['《', '》'], ['【', '】'],
  ['〔', '〕'], ['〖', '〗'], ['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'],
]);

/** 闭符号到开符号的反查，用于判断输入的字符是不是闭符号。 */
const CLOSINGS: ReadonlyMap<string, string> = new Map([...OPENINGS].map(([open, close]) => [close, open]));

/** 输入法可能一次整体提交的成对文本到开符号；只有整段提交才会命中，逐个键入不受影响。 */
const PAIRS: ReadonlyMap<string, string> = new Map([...OPENINGS].map(([open, close]) => [open + close, open]));

/**
 * 光标右侧是这些字符时仍然补齐闭符号：闭符号本身与右标点，说明插入点位于语句停顿处。
 * 右侧是普通文字时不补，避免把闭符号插进已有内容；语义与 closeBrackets 的 `before` 相同。
 */
const PAIRABLE_BEFORE = new Set([...CLOSINGS.keys(), ':', ';', '，', '。', '、', '：', '；', '！', '？', '…', '—']);

/**
 * closeBrackets 的配对配置。
 * 说明：closeBrackets 只从语言数据的 `closeBrackets` 字段读取配对表，其默认表不含全角符号，这里补上。
 *   `<` 在 Markdown 中表示 HTML 标签与自动链接，交给键盘补齐会把 `<http://a>` 写成 `<http://a|>`，因此不纳入。
 *   优先级高于语言包，避免同名字段被覆盖。
 */
export const bracketCompletion = Prec.high(EditorState.languageData.of(() => [{
  closeBrackets: { brackets: [...OPENINGS.keys()].filter(open => open !== '<'), before: [...PAIRABLE_BEFORE].join('') },
}]));

/** 组合会话中刚提交的单个符号；组合结束后据此决定补闭符号还是跳过重复的闭符号。 */
const pendingSymbols = new WeakMap<EditorView, string>();

/**
 * 函数职责：在桌面输入法的组合会话中登记落在光标处的单个成对符号。
 * 输入说明：closeBrackets 在桌面组合期间主动跳过处理，中文输入法提交全角符号时不会触发补齐；
 *   这里只在组合期间登记，其余输入仍由 closeBrackets 按同一份配对表处理。
 * 输出说明：命中符号时只登记、正文交给默认插入，补齐留给组合结束后的 compositionend 处理。
 * 实现思路：组合期间任何正文改动都会与输入法写回 DOM 的组合文本竞争，浏览器随即重发组合事件，
 *   编辑器收不到 compositionend 就会一直停在组合态，此后所有键盘操作（含回车新建任务）都被忽略；
 *   因此这里不再当场补齐，等组合结束、正文落定之后再补。
 *   候选字转换会把刚写入的符号整段替换掉（`(` 转成 `（`），替换同样以光标为终点，
 *   所以只要求改动结束于光标；光标前到底留下了哪个符号，留到组合结束时核对。
 */
export const compositionBracketCompletion = [
  EditorView.inputHandler.of((view, from, to, text) => {
    if (!view.compositionStarted || view.state.readOnly) return false;
    const { main } = view.state.selection;
    if (text.length > 2 || text.length === 2 && codePointSize(codePointAt(text, 0)) === 1 || !main.empty || to !== main.to) return false;
    if (OPENINGS.has(text) || CLOSINGS.has(text)) pendingSymbols.set(view, text);
    else pendingSymbols.delete(view);
    return false;
  }),
  // 新组合会话必然改写正文，上一次登记在组合结束后就不再可靠，先清掉再等本次提交。
  EditorView.domEventHandlers({
    compositionstart: (_event, view) => { pendingSymbols.delete(view); },
    compositionend: (_event, view) => { completeComposingSymbol(view); },
  }),
];

/**
 * 函数职责：组合结束后，为该次提交的单个符号补齐闭符号，或跳过重复的闭符号。
 * 输入说明：只处理本控制器登记过、组合确已结束的提交；光标必须仍紧跟在登记符号之后，否则视为提交后被改写。
 * 输出说明：开符号补一枚闭符号并把光标留在两者之间；提交的闭符号正好落在刚补齐的闭符号之前时删掉提交的那一枚，
 *   等价于键盘上「移过去而不重复插入」；其余情况不改正文。
 * 实现思路：登记与落笔之间可能插入其他改动，落笔前重新核对正文位置，不符就放弃。
 *   开符号的成对事务仍由 insertBracket 按同一份配对表计算，只取它的效果来登记成对状态，
 *   让输入法补出的整对与键盘补齐一样可以一次 Backspace 删掉；文本改动按当前正文另建，不重放那笔事务的坐标。
 */
function completeComposingSymbol(view: EditorView): void {
  const text = pendingSymbols.get(view);
  pendingSymbols.delete(view);
  if (text === undefined || view.compositionStarted || view.state.readOnly) return;
  const state = view.state;
  const { main } = state.selection;
  const start = main.head - text.length;
  if (!main.empty || start < 0 || state.sliceDoc(start, main.head) !== text) return;
  const close = OPENINGS.get(text);
  if (close !== undefined && close !== text) {
    // 去掉已提交的符号，让 insertBracket 按「符号尚未写入」的正文判断右侧能否补齐并生成成对事务；
    // 自配对引号走另一套词边界规则，这里不接管，避免打断撇号这类输入。
    const pair = insertBracket(state.update({ changes: { from: start, to: main.head } }).state, text);
    if (!pair) return;
    view.dispatch(state.update({
      changes: { from: main.head, insert: close },
      selection: { anchor: main.head },
      effects: pair.effects,
      scrollIntoView: true,
      userEvent: 'input.type',
    }));
    return;
  }
  // 闭符号：右边紧邻同一枚闭符号说明它是刚补齐的那一枚，删掉这次提交的重复符号，光标停在保留的闭符号之后。
  if (!CLOSINGS.has(text) || state.sliceDoc(main.head, Math.min(main.head + text.length, state.doc.length)) !== text) return;
  view.dispatch({ changes: { from: start, to: main.head }, selection: { anchor: main.head }, scrollIntoView: true, userEvent: 'input.type' });
}

/**
 * 成对高亮的符号表，开闭两两排列。
 * 说明：自配对符号（引号）与尖括号在 Markdown 中容易被误判，只收录成对的括号与中文引号。
 */
export const matchingBrackets = '()[]{}（）［］｛｝〈〉《》【】〔〕〖〗「」『』“”‘’';

/** 函数职责：读取指定位置右侧的一个字符（含代理对），越界返回空串。 */
function nextChar(state: EditorState, pos: number): string {
  return [...state.sliceDoc(pos, Math.min(pos + 2, state.doc.length))][0] ?? '';
}

/** 函数职责：读取指定位置左侧的一个字符（含代理对），行首返回空串。 */
function prevChar(state: EditorState, pos: number): string {
  return [...state.sliceDoc(Math.max(0, pos - 2), pos)].pop() ?? '';
}

/** 函数职责：判断字符是否属于词字符；空串不算，用于识别光标右侧是否紧贴单词。 */
function isWordChar(state: EditorState, pos: number, char: string): boolean {
  return char !== '' && state.charCategorizer(pos)(char) === CharCategory.Word;
}

/** 函数职责：判断字符是否为 ASCII 字母、数字或下划线，用于识别英文单词内部的撇号。 */
function isAsciiWordChar(char: string): boolean {
  return /[0-9A-Za-z_]/.test(char);
}

/**
 * 函数职责：把光标移过右侧已有的闭符号，不产生新字符。
 * 实现思路：手机输入法的插入点只在文本发生变更时重新同步，所以删除该符号再在原位重写，
 *   用等价的文本改动换取光标前进；只改选区的事务会被输入法忽略，出现两个光标。
 */
function movePast(view: EditorView, from: number, text: string, userEvent?: string): void {
  view.dispatch({ changes: { from, to: from + text.length, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent });
}

/**
 * 补齐之后需要守住的光标位置。
 * 说明：闭符号是编辑器补的，输入法并不知情；它之后把插入点重新同步到新文本末尾时可能只改选区而没有输入事件，
 *   这种同步会把刚补齐的光标推到闭符号之后，只能在事务层面移回去，后续输入才会落在两个符号之间。
 */
interface CaretTarget {
  /** 光标被推到该位置即说明发生了回发，需要纠正。 */
  tail: number;
  /** 补齐后光标应停留的位置，即两个符号之间。 */
  caret: number;
  /** 过期时刻，超过后不再纠正，避免用户之后主动移走光标时被拉回。 */
  expiresAt: number;
  /** 剩余纠正次数，防止与输入法的回发互相覆盖。 */
  attempts: number;
}

/** 保位窗口（毫秒）：覆盖一次输入法回发的延迟，又不至于干扰用户随后的光标操作。 */
const CARET_GUARD_WINDOW = 300;

/** 保位窗口内最多纠正的次数：输入法不回发时不会触发，反复回发时也不会形成死循环。 */
const CARET_GUARD_ATTEMPTS = 2;

const caretTargets = new WeakMap<EditorView, CaretTarget>();

/**
 * 最近一次补齐留下的回发预期。
 * 说明：编辑器把输入法没有提交的闭符号写回 EditContext 之后，Android 会把这笔写入当成新的输入再回发一次 textupdate；
 *   它的形态与用户真的输入同一个闭符号完全一致（位置在闭符号处，内容就是该闭符号），只能靠它紧跟在补齐之后来区分。
 */
interface EchoExpectation {
  /** 闭符号的起始位置，也是刚补齐时光标所在的位置。 */
  from: number;
  /** 回发会提交的闭符号。 */
  text: string;
  /** 回发窗口的结束时刻，超出窗口的输入一律按用户输入处理。 */
  expiresAt: number;
}

/** 回发窗口（毫秒）：编辑器写回之后的系统回发在几毫秒内到达，窗口只需覆盖这段延迟。 */
const ECHO_WINDOW = 50;

const echoExpectations = new WeakMap<EditorView, EchoExpectation>();

/**
 * 函数职责：识别并消化「系统把编辑器写回的闭符号当成新输入回发」的一次提交。
 * 输入说明：只在回发窗口内、位置正好落在刚补的闭符号处、内容恰好是该闭符号的单字符提交才命中。
 * 输出说明：命中时按等价改写在原位置重写闭符号，把光标留在两个符号之间并返回 true；否则返回 false，交给正常输入处理。
 * 实现思路：等价改写而不新增字符，可让 EditContext 的文本与编辑器保持一致，同时不再触发新的回发；
 *   窗口之外的同一位置提交按用户输入处理，因此用户真的按闭符号时仍然会跳到闭符号之后。
 */
function consumeEcho(view: EditorView, from: number, text: string, userEvent?: string): boolean {
  const expectation = echoExpectations.get(view);
  if (!expectation) return false;
  if (performance.now() > expectation.expiresAt) {
    echoExpectations.delete(view);
    return false;
  }
  if (from !== expectation.from || text !== expectation.text) return false;
  echoExpectations.delete(view);
  view.dispatch({ changes: { from, to: from + text.length, insert: text }, selection: { anchor: from }, scrollIntoView: true, userEvent });
  keepCaret(view, from, from + text.length);
  return true;
}

/** 函数职责：登记一次保位，等待系统回发之后把光标移回两个符号之间。 */
function keepCaret(view: EditorView, caret: number, tail: number): void {
  caretTargets.set(view, { caret, tail, expiresAt: performance.now() + CARET_GUARD_WINDOW, attempts: CARET_GUARD_ATTEMPTS });
}

/**
 * 函数职责：把被系统回发推到闭符号之后的光标移回两个符号之间。
 * 输入说明：只处理保位窗口内、文档未变化、光标正好落在闭符号之后，且由系统选区变更（userEvent 为 select）触发的更新。
 * 输出说明：同一处补齐最多纠正两次；指针选择（用户自己把光标移走）立即放弃保位。
 * 实现思路：这类同步只改选区，因此纠正也用纯选区事务，只改光标不碰文本；
 *   纠正延后一帧派发，避免在视图更新过程中嵌套派发事务；派发后光标若再次被推走才会再次纠正。
 */
export const pairingCaret = EditorView.updateListener.of(update => {
  const target = caretTargets.get(update.view);
  if (!target) return;
  if (update.docChanged || performance.now() > target.expiresAt || target.attempts <= 0) {
    caretTargets.delete(update.view);
    return;
  }
  if (!update.selectionSet || !update.transactions.some(transaction => transaction.isUserEvent('select'))) return;
  const { main } = update.state.selection;
  if (!main.empty || main.head !== target.tail) return;
  if (update.transactions.some(transaction => transaction.isUserEvent('select.pointer'))) {
    caretTargets.delete(update.view);
    return;
  }
  target.attempts -= 1;
  requestAnimationFrame(() => {
    const { main: current } = update.view.state.selection;
    if (!current.empty || current.head !== target.tail) return;
    update.view.dispatch({ selection: { anchor: target.caret }, scrollIntoView: true });
  });
});

/**
 * 函数职责：识别输入法一次提交的成对符号并把光标放到中心。
 * 输入说明：只接管单光标、非只读的成对符号提交；输入法组合中的提交同样处理。
 * 输出说明：只派发一笔事务；输入法已居中时沿用默认插入，光标停在闭符号之后时改写为居中。
 * 实现思路：手机输入法的插入点只在文本发生变更时重新同步，单独派发一笔只改选区的事务会被忽略，
 *   出现"屏幕光标居中、实际输入落在闭符号之后"的分裂；因此把默认插入的文本改动与居中选区
 *   合并成一笔事务派发，既不改变最终文本，也让输入法读到新的光标位置。
 *   默认事务的 userEvent 原样保留，组合中的历史合并与 EditContext 同步依赖它。
 */
export const pairedSymbols = EditorView.inputHandler.of((view, from, to, text, insert) => {
  if (view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
  const opening = PAIRS.get(text);
  if (opening === undefined) return false;
  const inserted = insert();
  const { main } = inserted.state.selection;
  if (!main.empty || main.head !== from + text.length) {
    view.dispatch(inserted);
    return true;
  }
  view.dispatch(inserted.startState.update({
    changes: inserted.changes,
    selection: { anchor: from + opening.length },
    scrollIntoView: true,
    userEvent: inserted.annotation(Transaction.userEvent),
  }));
  keepCaret(view, from + opening.length, from + text.length);
  return true;
});

/**
 * 函数职责：手机端输入单个开符号时补齐闭符号，并把光标放到两符号之间。
 * 输入说明：只接管单光标、空选区的单字符输入；整对提交由 pairedSymbols 处理，桌面键盘由 closeBrackets 处理。
 * 输出说明：补对时派发一笔事务并返回 true；右侧已是同一闭符号且输入的就是该闭符号时移过去，不产生新字符；
 *   在一对符号内部再次输入同一个开符号时补齐内层闭符号，右侧原有闭符号不受影响。
 * 实现思路：手机输入法不在编辑器内配对，其事务必须带上文本改动才能同步插入点，因此补齐的文本与居中选区同笔派发；
 *   引号自配对时只在词边界补齐，避免打断 don't 这类撇号输入；补齐后登记回发预期与保位，
 *   前者消化输入法把写回的闭符号当成新输入的回发，后者兜住只改选区的插入点同步。
 */
export const singleSymbolPairs = EditorView.inputHandler.of((view, from, to, text, insert) => {
  if (view.state.readOnly || from !== to || text.length !== 1 || view.state.selection.ranges.length !== 1) return false;
  const userEvent = insert().annotation(Transaction.userEvent);
  if (consumeEcho(view, from, text, userEvent)) return true;
  const close = OPENINGS.get(text);
  if (close === undefined && !CLOSINGS.has(text)) return false;
  const state = view.state;
  const after = nextChar(state, from);
  if (close === undefined) {
    // 闭符号：右侧已是同一符号时只把光标移过去，避免插入重复的闭符号；否则交回默认插入，用户单独按闭符号照常输入。
    if (after !== text) return false;
    movePast(view, from, text, userEvent);
    return true;
  }
  // 自配对引号：右侧已有同一枚引号（通常是刚补齐的那枚）时同样只移过去。
  if (close === text && after === text) {
    movePast(view, from, text, userEvent);
    return true;
  }
  // 引号自配对只在词边界补齐：紧跟 ASCII 字母或数字时按撇号缩写处理（don't）不补，
  // 汉字之后是中文写作里输入引号的常见位置，照常补齐；右侧紧跟词字符（含汉字）时也不补，避免把词拆开。
  if (close === text) {
    if (isAsciiWordChar(prevChar(state, from)) || isWordChar(state, from, after)) return false;
  } else if (after !== '' && !PAIRABLE_BEFORE.has(after) && !/\s/.test(after)) return false;
  // 走到这里的开符号一律补齐：右侧为空、空白或停顿标点（含闭符号）都算可插入位置，
  // 后者覆盖在一对符号内部再次输入同一个开符号的情况（`(|)` 输入 `(` 得到 `(())`），右侧原有闭符号保持不动。
  view.dispatch({ changes: { from, insert: text + close }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent });
  keepCaret(view, from + text.length, from + text.length + close.length);
  echoExpectations.set(view, { from: from + text.length, text: close, expiresAt: performance.now() + ECHO_WINDOW });
  return true;
});
