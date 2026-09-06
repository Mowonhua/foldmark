/**
 * 文件职责：共享公式语法，确保编辑预览与任务识别使用同一棵树。
 * 定义范围：块公式、行内公式及 Markdown 扩展组合。
 */
import { GFM, type MarkdownConfig, type MarkdownExtension } from '@lezer/markdown';

/**
 * 结构职责：定义公式节点及美元定界规则。
 * 字段说明：MathBlock 覆盖整块，InlineMath 覆盖行内定界符。
 * 约束条件：未闭合块延续至所属容器结束；公式内不再解析 Markdown 列表。
 */
export const mathExtension: MarkdownConfig = {
  defineNodes: [{ name: 'MathBlock', block: true }, 'InlineMath'],
  parseBlock: [{
    name: 'MathBlock', before: 'FencedCode',
    parse(cx, line) {
      const opening = line.text.slice(line.pos).trimEnd();
      if (!opening.startsWith('$$')) return false;
      const from = cx.lineStart + line.pos;
      let to = cx.lineStart + line.text.length;
      const indent = line.baseIndent;
      if (opening.length > 3 && opening.endsWith('$$')) {
        cx.nextLine(); cx.addElement(cx.elt('MathBlock', from, to)); return true;
      }
      while (cx.nextLine()) {
        // 公式不能吞掉所属列表之外的下一条目；空行允许留在公式中。
        if (line.text.trim() && line.baseIndent < indent) break;
        to = cx.lineStart + line.text.length;
        if (line.text.slice(line.pos).trim() === '$$') { cx.nextLine(); break; }
      }
      cx.addElement(cx.elt('MathBlock', from, to));
      return true;
    },
    endLeaf(_cx, line) { return line.text.slice(line.pos).startsWith('$$'); },
  }],
  parseInline: [{
    name: 'InlineMath', before: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== 36 || cx.char(pos + 1) === 36) return -1;
      for (let end = pos + 1; end < cx.end; end++) {
        if (cx.char(end) === 10) return -1;
        if (cx.char(end) === 92) { end++; continue; }
        if (cx.char(end) === 36) return cx.addElement(cx.elt('InlineMath', pos, end + 1));
      }
      return -1;
    },
  }],
};
export const markdownExtensions: MarkdownExtension = [GFM, mathExtension];
