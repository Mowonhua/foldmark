/**
 * 文件职责：按中文写作工具的字数口径统计文本。
 * 定义范围：汉字、假名、谚文逐字计数；连续拉丁字母和数字按一个词计数；标点、空白及其他符号不计。
 */

// 英文词内部的撇号与连字符不拆词，例如 don't、state-of-the-art。
const COUNTED_TOKEN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{Script=Latin}\p{Nd}]+(?:['’\-][\p{Script=Latin}\p{Nd}]+)*|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}{1,2}/gu;

/**
 * 函数职责：统计文本字数。
 * 输入说明：任意可见文本，可混排中文、英文、数字、Emoji 与 Markdown 标记。
 * 输出说明：汉字等表意字符按码点逐字计数，连续字母或数字按一个词计数，标点与空白不产生计数。
 */
export function countWords(text: string): number {
  let count = 0;
  for (const _match of text.matchAll(COUNTED_TOKEN)) count += 1;
  return count;
}
