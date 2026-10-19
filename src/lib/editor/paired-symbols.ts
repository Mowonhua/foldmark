/**
 * 文件职责：定义成对符号表，并处理输入时的自动补齐与光标居中。
 * 定义范围：符号表、单个开符号补齐、输入法整对提交居中、closeBrackets 与成对高亮的配对配置。
 */
import { CharCategory, EditorState, Prec, Transaction } from '@codemirror/state';
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

/** 函数职责：判断字符是否属于词字符；空串不算，用于识别引号是否贴在单词上。 */
function isWordChar(state: EditorState, pos: number, char: string): boolean {
  return char !== '' && state.charCategorizer(pos)(char) === CharCategory.Word;
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
  return true;
});

/**
 * 函数职责：手机端输入单个开符号时补齐闭符号，并把光标放到两符号之间。
 * 输入说明：只接管单光标、空选区的单字符输入；整对提交由 pairedSymbols 处理，桌面键盘由 closeBrackets 处理。
 * 输出说明：补对或移过已有闭符号时派发一笔事务并返回 true；其余情况返回 false，交回默认插入。
 * 实现思路：手机输入法不在编辑器内配对，其事务必须带上文本改动才能同步插入点，因此补齐的文本与居中选区同笔派发；
 *   引号自配对时只在词边界补齐，避免打断 don't 这类撇号输入；右侧已是同一符号时移过去而不是重复插入。
 */
export const singleSymbolPairs = EditorView.inputHandler.of((view, from, to, text, insert) => {
  if (view.state.readOnly || from !== to || text.length !== 1 || view.state.selection.ranges.length !== 1) return false;
  const close = OPENINGS.get(text);
  if (close === undefined && !CLOSINGS.has(text)) return false;
  const state = view.state;
  const after = nextChar(state, from);
  const userEvent = insert().annotation(Transaction.userEvent);
  // 闭符号、以及已经补齐的引号，右侧出现同一符号时都只把光标移过去。
  if (after === (close ?? text)) {
    movePast(view, from, text, userEvent);
    return true;
  }
  if (close === undefined) return false;
  // 引号自配对只在词边界补齐：贴在单词前后都不补，避免打断 don't 这类撇号输入。
  if (close === text) {
    if (isWordChar(state, from, prevChar(state, from)) || isWordChar(state, from, after)) return false;
  } else if (after !== '' && !PAIRABLE_BEFORE.has(after) && !/\s/.test(after)) return false;
  view.dispatch({ changes: { from, insert: text + close }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent });
  return true;
});
