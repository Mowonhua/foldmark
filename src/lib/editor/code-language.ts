/**
 * 文件职责：提供代码围栏语言的就地编辑控件。
 * 定义范围：语言标记事务与代码框外的输入控件。
 */
import { get } from 'svelte/store';
import { translate, locale } from '../i18n';
import { EditorView, WidgetType } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import type { SyntaxNode } from '@lezer/common';
import { documentField } from './state';

/**
 * 函数职责：更新指定围栏的语言标记，保留代码正文和其他围栏信息。
 * 输入说明：from 为当前文档中开围栏位置；语言为单个不含空白或围栏字符的标识，空值表示纯文本。
 * history 为 full 时独立撤销；输入会话首笔使用 before，后续 join 合并相邻输入。
 * 输出说明：合法变更提交为一笔可撤销事务；只读、位置失效或非法输入返回 false。
 * 实现思路：从共享语法树定位开围栏，只替换 CodeInfo 的首个标识。
 */
export function setCodeLanguage(view: EditorView, from: number, language: string, history: 'full' | 'before' | 'join' = 'full'): boolean {
  if (view.state.readOnly || /[\r\n\u0000-\u001f\u007f]/.test(language)) return false;
  const value = language.trim();
  if (/[\s`~]/.test(value) || from < 0 || from > view.state.doc.length) return false;
  const model = view.state.field(documentField);
  let node: SyntaxNode | null = model.tree.resolveInner(from, 1);
  while (node && node.name !== 'FencedCode') node = node.parent;
  const mark = node?.getChild('CodeMark');
  if (!node || node.from !== from || !mark) return false;
  const info = node.getChild('CodeInfo');
  const current = info ? model.text.slice(info.from, info.to) : '';
  const token = current.match(/^\S*/)?.[0] ?? '';
  const suffix = current.slice(token.length);
  // 附加信息不能移到语言位置；清空带附加信息的语言时用 text 保持其原有语义。
  const replacement = value || (suffix ? 'text' : '');
  const start = info?.from ?? mark.to;
  const end = start + token.length;
  if (model.text.slice(start, end) !== replacement) {
    view.dispatch({ changes: { from: start, to: end, insert: replacement }, annotations: history === 'join' ? [] : isolateHistory.of(history), userEvent: 'input.type' });
  }
  return true;
}

/**
 * 结构职责：仅在编辑代码块时于框外右下方覆盖呈现语言输入，不占用后续正文行高。
 * 字段说明：from 和 language 来自同一围栏快照，用于控件复用及提交定位。
 * 约束条件：有效输入即时写回，连续输入可合并撤销；Enter 返回正文，Escape 恢复进入输入框时的语言。
 */
export class CodeLanguageWidget extends WidgetType {
  private readonly uiLocale = get(locale);
  constructor(readonly from: number, readonly language: string) { super(); }
  eq(other: CodeLanguageWidget): boolean { return this.uiLocale === other.uiLocale && this.from === other.from && this.language === other.language; }
  get estimatedHeight(): number { return 0; }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'fm-code-language';
    wrapper.contentEditable = 'false';
    const input = document.createElement('input');
    input.type = 'text'; input.value = this.language; input.placeholder = translate('代码语言');
    input.setAttribute('aria-label', translate('代码块语言')); input.title = translate('输入语言，回车返回代码');
    input.autocomplete = 'off'; input.spellcheck = false;
    wrapper.dataset.from = String(this.from);
    let original = this.language;
    let changed = false;
    const commit = (): boolean => {
      const saved = setCodeLanguage(view, Number(wrapper.dataset.from), input.value, changed ? 'join' : 'before');
      if (saved && input.value.trim() !== original) changed = true;
      input.setCustomValidity(saved ? '' : translate('语言名称不能包含空白或围栏字符'));
      return saved;
    };
    input.addEventListener('focus', () => { original = input.value; changed = false; });
    input.addEventListener('input', event => { if (!(event instanceof InputEvent) || !event.isComposing) commit(); });
    input.addEventListener('compositionend', commit);
    input.addEventListener('change', commit);
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); if (commit()) view.focus(); else input.reportValidity(); }
      if (event.key === 'Escape') { event.preventDefault(); input.value = original; commit(); view.focus(); }
    });
    wrapper.append(input);
    return wrapper;
  }
  /** 输入引发的语法重建复用同一 DOM，避免每次敲键重置焦点、光标和未完成的 IME 组合。 */
  updateDOM(dom: HTMLElement): boolean {
    dom.dataset.from = String(this.from);
    const input = dom.querySelector('input')!;
    if (document.activeElement !== input) input.value = this.language;
    input.placeholder = translate('代码语言');
    input.setAttribute('aria-label', translate('代码块语言'));
    input.title = translate('输入语言，回车返回代码');
    if (input.validity.customError) input.setCustomValidity(translate('语言名称不能包含空白或围栏字符'));
    return true;
  }
  ignoreEvent(): boolean { return true; }
}
