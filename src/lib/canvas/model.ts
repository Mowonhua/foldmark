/**
 * 文件职责：校验画布快照并读取 Markdown 内的画布附件引用。
 * 定义范围：版本化快照的创建、解析、原子序列化及有效围栏枚举。
 */
import type { CanvasAsset, CanvasDocument } from './types';
import { lineEnd, lineStart, parseDocument } from '../markdown/parse';
import type { Tree } from '@lezer/common';

/**
 * 结构职责：描述可整体替换的 Markdown 画布围栏。
 * 字段说明：from/to 含围栏和独立行缩进、不含尾换行；正文坐标保留原始缩进。
 * 约束条件：只包含闭合的 canvas 围栏；不支持的快照 document=null，但原文范围仍有效。
 */
export interface CanvasMarkdownBlock {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  indent: string;
  document: CanvasDocument | null;
}

/**
 * 函数职责：创建独立的空白画布。
 * 输入说明：title 为可选的用户标题。
 * 输出说明：返回 version=1、独立 id 且不含图片引用的快照。
 * 实现思路：为每次创建分配随机身份，使用空图形与附件集合。
 */
export function createCanvasDocument(title = '画布'): CanvasDocument {
  return { version: 1, id: crypto.randomUUID(), title, elements: [], files: {} };
}

/**
 * 函数职责：读取当前支持的 JSON 画布快照。
 * 输入说明：source 为 canvas 围栏中的 JSON 正文，不包含围栏。
 * 输出说明：损坏或不支持的结构返回 null，调用方必须保留原始文本。
 * 实现思路：校验版本、图形与附件引用边界，不修复、不丢弃未知字段。
 */
export function parseCanvasDocument(source: string): CanvasDocument | null {
  try {
    const value: unknown = JSON.parse(source);
    return validDocument(value) ? value : null;
  } catch { return null; }
}

/**
 * 函数职责：将完整快照保存为一行 JSON。
 * 输入说明：document 必须满足当前版本契约，不含图片数据 URL。
 * 输出说明：返回不含换行的原子快照；不支持的输入抛错，禁止降级写回。
 * 实现思路：以完整结构校验结果作为序列化前置条件，保留引擎字段。
 */
export function serializeCanvasDocument(document: CanvasDocument): string {
  const source = JSON.stringify(document);
  if (!parseCanvasDocument(source)) throw new Error('画布数据格式不受支持');
  return source;
}

/**
 * 函数职责：收集有效 canvas 围栏中的不可变图片附件。
 * 输入说明：text 为整份 Markdown，允许顶层与列表缩进的围栏。
 * 输出说明：按路径去重返回附件；普通代码、未闭合或损坏画布不产生引用。
 * 实现思路：复用共享 Markdown 语法树，只解析语法识别出的完整画布围栏。
 */
export function canvasAssetsFromText(text: string): CanvasAsset[] {
  const assets = new Map<string, CanvasAsset>();
  for (const block of scanCanvasBlocks(text)) {
    for (const asset of Object.values(block.document?.files ?? {})) assets.set(asset.path, asset);
  }
  return [...assets.values()];
}

/**
 * 函数职责：定位完整画布围栏，为编辑与同步提供原子范围。
 * 输入说明：text 为完整 Markdown 文档，坐标使用原始 UTF-16 文本。
 * 输出说明：按正文位置排序返回围栏；损坏快照保留范围，未闭合围栏不被视为画布。
 * 实现思路：共享 Markdown 语法限定代码范围，再按物理行提取 JSON 正文。
 */
const blockCache = new WeakMap<Tree, { text: string; blocks: CanvasMarkdownBlock[] }>();
/** 分块同步反复读取同一正文；仅保留最近两份快照，避免每个图片块都重新解析场景。 */
const recentBlocks: { text: string; blocks: CanvasMarkdownBlock[] }[] = [];
export function scanCanvasBlocks(text: string, tree?: Tree): CanvasMarkdownBlock[] {
  if (!text.includes('canvas')) return [];
  if (!tree) {
    const recent = recentBlocks.find(entry => entry.text === text);
    if (recent) return recent.blocks;
  }
  const syntax = tree ?? parseDocument(text).tree;
  const cached = blockCache.get(syntax);
  if (cached?.text === text) return cached.blocks;
  const blocks: CanvasMarkdownBlock[] = [];
  syntax.iterate({ enter(ref) {
    if (ref.name !== 'FencedCode') return;
    const info = ref.node.getChild('CodeInfo');
    const marks = ref.node.getChildren('CodeMark');
    if (!info || text.slice(info.from, info.to).trim() !== 'canvas' || marks.length !== 2) return false;
    const openingEnd = lineEnd(text, ref.from);
    const closingStart = lineStart(text, marks[1].from);
    const prefix = text.slice(lineStart(text, ref.from), ref.from);
    // 引用中的 > 是结构标记，不能在不理解容器的情况下剥离并写回。
    // 列表续行与顶层只含空白前缀；同行列表标记保留在块范围之外。
    const indent = prefix.replace(/\S/g, ' ');
    const bodyFrom = Math.min(text.indexOf('\n', openingEnd) + 1 || openingEnd, closingStart);
    const bodyTo = closingStart > bodyFrom ? closingStart - (text[closingStart - 2] === '\r' ? 2 : 1) : bodyFrom;
    const source = text.slice(bodyFrom, bodyTo).split(/\r?\n/).map(line => line.trim()).join('\n');
    blocks.push({ from: prefix.trim() ? ref.from : lineStart(text, ref.from), to: lineEnd(text, ref.to),
      bodyFrom, bodyTo, indent, document: parseCanvasDocument(source) });
    return false;
  } });
  blockCache.set(syntax, { text, blocks });
  recentBlocks.unshift({ text, blocks });
  if (recentBlocks.length > 2) recentBlocks.pop();
  return blocks;
}

const elementTypes = new Set(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw', 'text', 'image', 'frame']);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 附件必须是内容寻址的本地静态图片，不能将 data URL 或任意路径降级为合法引用。 */
function validAsset(value: unknown): value is CanvasAsset {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id)
    || !finite(value.size) || !Number.isSafeInteger(value.size) || value.size <= 0
    || !finite(value.created) || value.created < 0 || 'dataURL' in value) return false;
  const extensions: Record<string, readonly string[]> = { 'image/png': ['png'], 'image/jpeg': ['jpg'], 'image/webp': ['webp'] };
  return typeof value.mimeType === 'string' && !!extensions[value.mimeType]?.some(extension => value.path === `.assets/${value.id}.${extension}`);
}

/** 未识别的顶层字段不丢弃；引擎对象只检查稳定基础契约，额外属性由引擎原样保留。 */
function validDocument(value: unknown): value is CanvasDocument {
  if (!record(value) || value.version !== 1 || typeof value.id !== 'string' || !value.id
    || typeof value.title !== 'string' || !Array.isArray(value.elements) || !record(value.files)) return false;
  if (!Object.values(value.files).every(validAsset)) return false;
  const ids = new Set<string>();
  for (const element of value.elements) {
    if (!record(element) || typeof element.id !== 'string' || !element.id || ids.has(element.id)
      || typeof element.type !== 'string' || !elementTypes.has(element.type)
      || !['x', 'y', 'width', 'height'].every(key => finite(element[key])) || 'dataURL' in element) return false;
    ids.add(element.id);
    // 已删除的图片也保留引用，保证恢复与撤销仍能读取同一附件。
    if (element.type === 'image' && (typeof element.fileId !== 'string' || !Object.hasOwn(value.files, element.fileId))) return false;
  }
  return true;
}
