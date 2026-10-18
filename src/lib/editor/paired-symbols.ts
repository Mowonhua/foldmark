/**
 * 文件职责：输入法一次提交成对符号时把光标移到符号之间。
 * 定义范围：成对符号识别、输入处理扩展；不改写正文，也不向撤销历史写入光标位置。
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
 * 输入说明：只接管单光标、非只读、非组合输入的成对符号提交。
 * 输出说明：先执行默认插入；输入法已把光标放在中心时不再改动，停在闭符号之后才追加一笔不写入历史的选区事务。
 * 实现思路：以插入后的真实选区判断输入法是否已经居中，避免与已经正确的输入法重复改写。
 */
export const pairedSymbols = EditorView.inputHandler.of((view, from, to, text, insert) => {
  if (view.composing || view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
  const opening = PAIRS.get(text);
  if (opening === undefined) return false;
  view.dispatch(insert());
  const { main } = view.state.selection;
  if (main.empty && main.head === from + text.length)
    view.dispatch({ selection: { anchor: from + opening.length }, scrollIntoView: true, annotations: Transaction.addToHistory.of(false) });
  return true;
});
