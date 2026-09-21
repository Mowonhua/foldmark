/**
 * 文件职责：为任务折叠引起的可见行重排提供短暂位移动画。
 * 定义范围：折叠前后几何采样、逐行动画和输入中断，不参与正文或折叠状态修改。
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

/**
 * 接口职责：包裹同步折叠命令并在布局稳定后动画呈现行位置变化。
 * 调用方：编辑器公开折叠入口及 CodeMirror 插件生命周期。
 * 实现要求：源码和减少动态效果时直接执行命令；编辑、滚动、再次切换和销毁立即取消动画。
 */
export class FoldMotion {
  private generation = 0;
  private readonly animations = new Set<Animation>();
  private destroyed = false;

  constructor(private readonly view: FoldMotionView) {
    // 用户开始移动指针定位正文时即稳定文字；输入处理前移除 transform，避免命中测试持续使用偏移布局。
    for (const event of ['pointermove', 'pointerdown', 'keydown', 'beforeinput']) view.dom.addEventListener(event, this.cancel, true);
    for (const event of ['scroll', 'wheel']) view.scrollDOM.addEventListener(event, this.cancel, { passive: true });
  }

  /**
   * 函数职责：保持折叠命令同步语义，仅对后续视觉重排添加过渡。
   * 输入说明：change 只执行一次同步折叠事务，不得异步修改正文。
   * 输出说明：命令完成后返回，动画通过 CodeMirror 测量阶段启动且不改变选区或历史。
   * 实现思路：以文档位置关联前后可见行，逐行从旧纵坐标平移到新的布局位置。
   */
  run(change: () => void): void {
    this.cancel();
    const reduced = this.view.dom.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (this.destroyed || reduced || this.view.state.facet(modeFacet) === 'source' || typeof this.view.contentDOM.animate !== 'function') {
      change(); return;
    }
    const before = new Map(this.visibleLines().map(line => [line.from, line.top]));
    change();
    // 同步折叠事务可能收拢选区并触发 update；只在事务返回后登记这一轮测量的有效代次。
    const generation = this.generation;
    this.view.requestMeasure({
      key: this,
      read: () => generation === this.generation && !this.destroyed ? this.visibleLines() : [],
      write: lines => {
        if (generation !== this.generation || this.destroyed) return;
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
    for (const event of ['pointermove', 'pointerdown', 'keydown', 'beforeinput']) this.view.dom.removeEventListener(event, this.cancel, true);
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
  };
}

export const foldMotion = ViewPlugin.fromClass(FoldMotion);
