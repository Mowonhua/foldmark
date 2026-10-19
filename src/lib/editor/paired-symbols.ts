/**
 * 文件职责：输入法一次提交成对符号时把光标移到符号之间。
 * 定义范围：成对符号识别、输入处理扩展；只决定插入后的光标位置，不改变最终文本。
 */
import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * 输入法可整体提交的成对符号。
 * 键是提交后的完整字符串，值是开符号；只有整段提交才会命中，逐个键入不受影响。
 */
const PAIRS: ReadonlyMap<string, string> = new Map([
  ['()', '('], ['[]', '['], ['{}', '{'], ['<>', '<'],
  ['（）', '（'], ['［］', '［'], ['【】', '【'], ['｛｝', '｛'], ['〔〕', '〔'], ['〖〗', '〖'],
  ['《》', '《'], ['〈〉', '〈'], ['「」', '「'], ['『』', '『'],
  ['""', '"'], ["''", "'"], ['“”', '“'], ['‘’', '‘'],
]);

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
