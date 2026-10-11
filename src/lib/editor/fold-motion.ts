/**
 * 文件职责：为任务折叠提供正文淡出和可见行重排动画。
 * 定义范围：几何采样、只读视觉副本、逐行动画和输入中断，不参与正文或折叠状态修改。
 */
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { foldsField, modeFacet } from './state';

/**
 * 结构职责：限定动画层对编辑视图的只读布局与测量依赖。
 * 字段说明：文档位置用于关联折叠前后的行，不依赖 DOM 节点身份保持不变。
 * 约束条件：不得通过此接口派发编辑事务或改写正文。
 */
type FoldMotionView = Pick<EditorView, 'dom' | 'contentDOM' | 'scrollDOM' | 'state' | 'posAtDOM' | 'requestMeasure'>;

/**
 * 结构职责：记录一条可见行的当前文档位置和屏幕纵坐标。
 * 字段说明：top 为 viewport 坐标，line 是该次采样仍挂载的行节点。
 * 约束条件：仅记录滚动区域内可见的 cm-line，不记录整个内容容器。
 */
interface VisibleLine { from: number; top: number; line: HTMLElement }

/** 收起范围使用源码坐标；视觉副本只覆盖该范围内本次真正消失的可见行。 */
interface CollapsingContent { from: number; to: number }

/**
 * 接口职责：包裹同步折叠命令并在布局稳定后动画呈现行位置变化。
 * 调用方：编辑器公开折叠入口及 CodeMirror 插件生命周期。
 * 实现要求：源码和减少动态效果时直接执行命令；编辑、滚动、再次切换和销毁立即取消动画。
 */
export class FoldMotion {
  private generation = 0;
  private readonly animations = new Set<Animation>();
  private readonly outgoingLayers = new Set<HTMLElement>();
  private destroyed = false;

  constructor(private readonly view: FoldMotionView) {
    // 实际定位或输入前稳定文字；普通悬停不能截断收起动画。
    for (const event of ['pointerdown', 'keydown', 'beforeinput']) view.dom.addEventListener(event, this.cancel, true);
    for (const event of ['scroll', 'wheel']) view.scrollDOM.addEventListener(event, this.cancel, { passive: true });
  }

  /**
   * 函数职责：保持折叠命令同步语义，仅对后续视觉重排添加过渡。
   * 输入说明：change 只执行一次同步折叠事务；collapsing 可选，指定本次收起的正文范围。
   * 输出说明：命令完成后返回，动画通过 CodeMirror 测量阶段启动且不改变选区或历史。
   * 实现思路：消失正文用只读副本淡出；保留行按文档位置关联，从旧坐标平移到新布局位置。
   */
  run(change: () => void, collapsing?: CollapsingContent): void {
    this.cancel();
    const reduced = this.view.dom.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (this.destroyed || reduced || this.view.state.facet(modeFacet) === 'source' || typeof this.view.contentDOM.animate !== 'function') {
      change(); return;
    }
    const visible = this.visibleLines();
    const before = new Map(visible.map(line => [line.from, line.top]));
    const viewport = this.view.scrollDOM.getBoundingClientRect();
    const typography = this.view.dom.ownerDocument.defaultView!.getComputedStyle(this.view.contentDOM);
    // 同步事务会移除正文 DOM，因此先保存只读副本。副本不参与布局、编辑、焦点或指针命中。
    const outgoing = collapsing ? visible.filter(line => line.from >= collapsing.from && line.from <= collapsing.to).map(({ from, line }) => ({
      from, element: line.cloneNode(true) as HTMLElement, rect: line.getBoundingClientRect(),
    })) : [];
    change();
    // 同步折叠事务可能收拢选区并触发 update；只在事务返回后登记这一轮测量的有效代次。
    const generation = this.generation;
    this.view.requestMeasure({
      key: this,
      read: () => generation === this.generation && !this.destroyed ? this.visibleLines() : [],
      write: lines => {
        if (generation !== this.generation || this.destroyed) return;
        const remaining = new Set(lines.map(line => line.from));
        const removed = outgoing.filter(line => !remaining.has(line.from));
        if (removed.length) {
          const layer = document.createElement('div');
          layer.className = 'fm-fold-outgoing'; layer.setAttribute('aria-hidden', 'true'); layer.contentEditable = 'false'; layer.inert = true;
          Object.assign(layer.style, { position: 'fixed', left: `${viewport.left}px`, top: `${viewport.top}px`, width: `${viewport.width}px`, height: `${viewport.height}px`, overflow: 'hidden', pointerEvents: 'none', font: typography.font, lineHeight: typography.lineHeight });
          for (const { element, rect } of removed) {
            // 原行的缩进是 margin-left；固定副本按已测量的边框坐标定位，不能再叠加该缩进。
            Object.assign(element.style, { position: 'absolute', left: `${rect.left - viewport.left}px`, top: `${rect.top - viewport.top}px`, width: `${rect.width}px`, margin: '0', boxSizing: 'border-box' });
            layer.append(element);
          }
          this.view.dom.append(layer); this.outgoingLayers.add(layer);
          const animation = layer.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 120, easing: 'ease-out' });
          this.animations.add(animation);
          const release = () => { this.animations.delete(animation); this.outgoingLayers.delete(layer); layer.remove(); };
          void animation.finished.then(release, release);
        }
        for (const { from, top, line } of lines) {
          const previous = before.get(from);
          if (previous === undefined || Math.abs(previous - top) < 0.5 || !line.isConnected) continue;
          const animation = line.animate([
            { transform: `translateY(${previous - top}px)` }, { transform: 'translateY(0)' },
          ], { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
          this.animations.add(animation);
          // cancel 会拒绝 finished；两条完成路径都只释放引用，不把正常中断报告为错误。
          void animation.finished.then(() => this.animations.delete(animation), () => this.animations.delete(animation));
        }
      },
    });
  }

  update(update: Pick<ViewUpdate, 'docChanged' | 'selectionSet' | 'state' | 'startState'>): void {
    if (update.docChanged || update.selectionSet || update.state.facet(modeFacet) !== update.startState.facet(modeFacet)
      || update.state.field(foldsField, false) !== update.startState.field(foldsField, false)) this.cancel();
  }

  destroy(): void {
    this.destroyed = true; this.cancel();
    for (const event of ['pointerdown', 'keydown', 'beforeinput']) this.view.dom.removeEventListener(event, this.cancel, true);
    for (const event of ['scroll', 'wheel']) this.view.scrollDOM.removeEventListener(event, this.cancel);
  }

  /** 只扫描 CodeMirror 已挂载行；视口缓冲行和新出现的行不进入折叠前后对应关系。 */
  private visibleLines(): VisibleLine[] {
    const viewport = this.view.scrollDOM.getBoundingClientRect();
    const lines: VisibleLine[] = [];
    for (const line of this.view.contentDOM.querySelectorAll<HTMLElement>(':scope > .cm-line')) {
      const rect = line.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      lines.push({ from: this.view.posAtDOM(line), top: rect.top, line });
    }
    return lines;
  }

  private cancel = (): void => {
    this.generation++;
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    for (const layer of this.outgoingLayers) layer.remove();
    this.outgoingLayers.clear();
  };
}

export const foldMotion = ViewPlugin.fromClass(FoldMotion);
