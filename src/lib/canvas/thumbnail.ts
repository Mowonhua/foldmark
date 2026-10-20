/**
 * 文件职责：为折叠画布生成轻量内容预览。
 * 定义范围：安全 SVG 绘制与可见控件的图片资源生命周期，不加载白板引擎。
 */
import type { CanvasAsset, CanvasDocument } from './types';

/** 接口职责：将预览 DOM 与附件资源的释放绑定；控件卸载后不再创建图片 URL。 */
export interface CanvasThumbnail { element: SVGSVGElement; dispose(): void }

/**
 * 函数职责：按画布内容边界生成文字、图形、线条与图片预览。
 * 输入说明：canvas 为已校验快照；图片读取端口可省略，失败时保留占位图。
 * 输出说明：返回独立 SVG 和幂等释放操作；不产生正文事务。
 * 实现思路：用 SVG 原语呈现内容，图片按引用去重并串行恢复。
 */
export function createCanvasThumbnail(canvas: CanvasDocument, resolveImage?: (asset: CanvasAsset) => Promise<Blob>): CanvasThumbnail {
  const svg = node('svg', { class: 'fm-canvas-thumbnail', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });
  const elements = canvas.elements.filter(element => !element.isDeleted);
  const imageNodes = new Map<string, SVGImageElement[]>();
  const urls: string[] = [];
  let disposed = false;
  if (!elements.length) {
    svg.setAttribute('viewBox', '0 0 120 60');
    svg.classList.add('fm-canvas-empty');
    svg.append(node('path', { d: 'M42 15h24v20H42z M62 26h18v18H62 M47 21h12 M47 26h9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1 }));
  } else {
    const bounds = elements.map(element => {
      const width = Number(element.width), height = Number(element.height), angle = Number(element.angle) || 0;
      const halfWidth = (Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle))) / 2;
      const halfHeight = (Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle))) / 2;
      const cx = Number(element.x) + width / 2, cy = Number(element.y) + height / 2;
      return { left: cx - halfWidth, right: cx + halfWidth, top: cy - halfHeight, bottom: cy + halfHeight };
    });
    const left = Math.min(...bounds.map(bound => bound.left)), top = Math.min(...bounds.map(bound => bound.top));
    const width = Math.max(1, Math.max(...bounds.map(bound => bound.right)) - left);
    const height = Math.max(1, Math.max(...bounds.map(bound => bound.bottom)) - top);
    const padding = Math.max(8, Math.min(width, height) * .06);
    svg.setAttribute('viewBox', `${left - padding} ${top - padding} ${width + padding * 2} ${height + padding * 2}`);
    for (const element of elements) svg.append(draw(element, imageNodes));
  }
  // 控件只在可见窗口创建。按引用去重、串行读取，避免多图预览同时分配原始附件副本。
  void (async () => {
    if (!resolveImage) return;
    for (const [id, images] of imageNodes) {
      if (disposed) return;
      const asset = canvas.files[id];
      if (!asset) continue;
      try {
        const blob = await resolveImage(asset);
        if (disposed) return;
        const url = URL.createObjectURL(blob); urls.push(url);
        for (const image of images) {
          image.setAttribute('href', url);
          image.closest('[data-element]')?.querySelector('[data-image-placeholder]')?.setAttribute('visibility', 'hidden');
        }
      } catch { /* 附件不可用时保留几何占位，不阻塞正文阅读或显示错误弹窗。 */ }
    }
  })();
  return { element: svg, dispose() {
    if (disposed) return;
    disposed = true;
    for (const images of imageNodes.values()) for (const image of images) image.removeAttribute('href');
    for (const url of urls) URL.revokeObjectURL(url);
  } };
}

const ns = 'http://www.w3.org/2000/svg';
/** SVG 属性来自已校验几何；文字只通过 textContent 写入，不解释为 HTML。 */
function node<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(ns, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

/** 保存的填充色可直接用于静态预览；描边和文字沿用主题前景，保证浅深背景下可辨认。 */
function fillColor(value: unknown): string {
  return typeof value === 'string' && /^(?:#[a-f\d]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(value) ? value : 'none';
}

function draw(element: Record<string, unknown>, images: Map<string, SVGImageElement[]>): SVGGElement {
  const width = Number(element.width), height = Number(element.height), angle = (Number(element.angle) || 0) * 180 / Math.PI;
  const group = node('g', { 'data-element': String(element.id), transform: `translate(${element.x} ${element.y}) rotate(${angle} ${width / 2} ${height / 2})`,
    opacity: Math.min(100, Math.max(0, Number(element.opacity ?? 100))) / 100, stroke: 'currentColor', 'stroke-width': Number(element.strokeWidth) || 1, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', fill: fillColor(element.backgroundColor) });
  if (element.strokeStyle === 'dashed') group.setAttribute('stroke-dasharray', '8 5');
  if (element.strokeStyle === 'dotted') group.setAttribute('stroke-dasharray', '1 5');
  if (element.type === 'text') {
    const size = Number(element.fontSize) || 20;
    const align = element.textAlign === 'center' ? 'middle' : element.textAlign === 'right' ? 'end' : 'start';
    const text = node('text', { x: align === 'middle' ? width / 2 : align === 'end' ? width : 0, y: size, 'font-size': size,
      'font-family': 'var(--document-font)', 'text-anchor': align, fill: 'currentColor', stroke: 'none' });
    for (const [index, line] of String(element.text ?? '').split('\n').entries()) {
      const span = node('tspan', { x: text.getAttribute('x')!, dy: index ? size * (Number(element.lineHeight) || 1.25) : 0 });
      span.textContent = line; text.append(span);
    }
    group.append(text);
  } else if (element.type === 'line' || element.type === 'arrow' || element.type === 'freedraw') {
    const points = Array.isArray(element.points) ? element.points.filter((point): point is number[] => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(value => typeof value === 'number' && Number.isFinite(value))) : [];
    group.append(node('polyline', { points: points.map(point => `${point[0]},${point[1]}`).join(' '), fill: 'none' }));
    if (element.type === 'arrow' && points.length > 1) {
      const head = (tip: number[], previous: number[], kind: unknown) => {
        if (!kind) return;
        const direction = Math.atan2(tip[1] - previous[1], tip[0] - previous[0]);
        const length = Math.min(18, Math.max(8, Math.hypot(tip[0] - previous[0], tip[1] - previous[1]) / 4));
        const wing = (offset: number) => `${tip[0] - length * Math.cos(direction + offset)},${tip[1] - length * Math.sin(direction + offset)}`;
        group.append(node('polyline', { points: `${wing(-.4)} ${tip[0]},${tip[1]} ${wing(.4)}`, fill: 'none' }));
      };
      head(points[0], points[1], element.startArrowhead); head(points.at(-1)!, points.at(-2)!, element.endArrowhead);
    }
  } else if (element.type === 'ellipse') group.append(node('ellipse', { cx: width / 2, cy: height / 2, rx: width / 2, ry: height / 2 }));
  else if (element.type === 'diamond') group.append(node('polygon', { points: `${width / 2},0 ${width},${height / 2} ${width / 2},${height} 0,${height / 2}` }));
  else {
    group.append(node('rect', { width, height, rx: element.roundness ? Math.min(12, width / 4, height / 4) : 0 }));
    if (element.type === 'image' && typeof element.fileId === 'string') {
      group.firstElementChild?.setAttribute('data-image-placeholder', 'true');
      const image = node('image', { width, height, preserveAspectRatio: 'none' });
      const crop = element.crop as Record<string, number> | undefined;
      // 裁切只改变预览窗口，仍复用原始附件；翻转作用于窗口外层，保留裁切坐标。
      const flipped = node('g'); group.append(flipped);
      if (Array.isArray(element.scale)) flipped.setAttribute('transform', `translate(${element.scale[0] === -1 ? width : 0} ${element.scale[1] === -1 ? height : 0}) scale(${element.scale[0] === -1 ? -1 : 1} ${element.scale[1] === -1 ? -1 : 1})`);
      let imageHost: SVGElement = flipped;
      if (crop && [crop.x, crop.y, crop.width, crop.height, crop.naturalWidth, crop.naturalHeight].every(Number.isFinite) && crop.width > 0 && crop.height > 0) {
        const window = node('svg', { width, height, viewBox: `${crop.x} ${crop.y} ${crop.width} ${crop.height}`, preserveAspectRatio: 'none', overflow: 'hidden' });
        image.setAttribute('width', String(crop.naturalWidth)); image.setAttribute('height', String(crop.naturalHeight));
        flipped.append(window); imageHost = window;
      }
      imageHost.append(image);
      const targets = images.get(element.fileId) ?? []; targets.push(image); images.set(element.fileId, targets);
    }
  }
  return group;
}
