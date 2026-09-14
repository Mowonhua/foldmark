/**
 * 文件职责：协调原生窗口材质与网页透明状态。
 * 定义范围：串行应用平台材质、忽略过期结果、失败时恢复实色。
 */

/** 原生适配器只接收固定材质名称；opaque 为缺省及双色主题的回退。 */
export type WindowMaterial = 'opaque' | 'transparent' | 'blur' | 'acrylic';

/**
 * 结构职责：保持原生窗口变更与透明 CSS 开关一致。
 * 约束条件：只有最新请求成功才可透明；原生调用必须串行，避免旧效果晚于新效果落地。
 */
export class WindowMaterialController {
  private queue: Promise<void> = Promise.resolve();
  private revision = 0;

  /** applyNative 返回 false 表示平台不支持，抛错表示应用失败；两者都保持实色。 */
  constructor(private root: HTMLElement, private applyNative: (material: WindowMaterial, theme: 'light' | 'dark' | 'system') => Promise<boolean>) {}

  /**
   * 函数职责：按请求顺序切换原生材质，只发布最后一次请求的网页透明状态。
   * 输入说明：material 已由主题校验限制；旧主题传 opaque；theme 保留 system 以解除原生显式主题；否则传当前浅深模式。
   * 输出说明：完成后原生状态已应用，错误传给调用方且不阻断后续切换。
   * 实现思路：先恢复实色，再将原生操作入队；用请求序号忽略过期结果。
   */
  update(material: WindowMaterial, theme: 'light' | 'dark' | 'system' = 'light'): Promise<void> {
    const revision = ++this.revision;
    this.root.dataset.windowTransparent = 'false';
    const operation = this.queue.then(async () => {
      const supported = await this.applyNative(material, theme);
      if (revision === this.revision) this.root.dataset.windowTransparent = String(supported && material !== 'opaque');
    });
    // 吞掉的仅是内部队列错误，当前调用方仍收到原始异常；后续主题切换可继续恢复。
    this.queue = operation.catch(() => {});
    return operation;
  }
}
