/**
 * 文件职责：向状态装饰提供带缓冲的可见源文窗口。
 * 定义范围：视口位置映射与异步更新，不创建第二份正文。
 */
import { StateEffect, StateField, Transaction } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';

export const setPreviewWindow = StateEffect.define<{ from: number; to: number }>();
export const previewWindowField = StateField.define<{ from: number; to: number }>({
  create: state => ({ from: 0, to: Math.min(state.doc.length, 6000) }),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setPreviewWindow)) return effect.value;
    return transaction.docChanged ? { from: transaction.changes.mapPos(value.from), to: transaction.changes.mapPos(value.to, 1) } : value;
  },
});

class PreviewWindow {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  constructor(private readonly view: EditorView) { this.schedule(); }
  update(update: ViewUpdate): void { if (update.viewportChanged) this.schedule(); }
  private schedule(): void {
    if (this.timer !== undefined) return;
    // 插件 update 内禁止嵌套事务；缓冲范围让正常滚动无需等待下一轮装饰提交。
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.destroyed) return;
      const viewport = this.view.viewport;
      const current = this.view.state.field(previewWindowField);
      if (viewport.from >= current.from + 1000 && viewport.to <= current.to - 1000) return;
      const next = { from: Math.max(0, viewport.from - 3000), to: Math.min(this.view.state.doc.length, viewport.to + 3000) };
      if (next.from !== current.from || next.to !== current.to) this.view.dispatch({ effects: setPreviewWindow.of(next), annotations: Transaction.addToHistory.of(false) });
    }, 0);
  }
  destroy(): void { this.destroyed = true; if (this.timer !== undefined) clearTimeout(this.timer); }
}

export const previewWindowPlugin = ViewPlugin.fromClass(PreviewWindow);
