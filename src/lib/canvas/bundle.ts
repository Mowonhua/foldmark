/**
 * 文件职责：完整导入导出 Markdown 及其实际引用的画布图片。
 * 定义范围：ZIP 包结构、资源上限、引用完整性及附件先于正文的导入顺序。
 */
import type { CanvasAsset, CanvasAssetPort } from './types';
import { unzip, unzipSync, zip, type AsyncZippable, type Unzipped, type UnzipFileInfo } from 'fflate';
import { MAX_CANVAS_IMAGE_BYTES, validateCanvasAsset, verifyCanvasAssetBytes } from './assets';
import { scanCanvasBlocks } from './model';

export const MAX_CANVAS_BUNDLE_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ASSETS = 1024;
const manifestName = 'taskrail-bundle.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** 结构职责：记录包版本与正文及图片的完整性信息；原始字节摘要由每个图片引用携带。 */
interface BundleManifest { format: 'taskrail-markdown-bundle'; version: 1; filename: string; assets: CanvasAsset[] }

/**
 * 结构职责：提供导出包需要的正文与附件访问能力。
 * 字段说明：assets 来自正文实际引用；filename 仅允许单级 Markdown 文件名。
 * 约束条件：documentPath 为附件源文档；不读取远程地址与绝对资源路径。
 */
export interface ExportBundleOptions {
  text: string;
  documentPath: string;
  assets: CanvasAsset[];
  port: CanvasAssetPort;
  filename?: string;
}

/** 结构职责：提供目标附件命名空间；只有全部附件保存完成才返回正文。 */
export interface ImportBundleOptions { bytes: Uint8Array; documentPath: string; port: CanvasAssetPort }

/**
 * 函数职责：生成可搬运的完整 Markdown ZIP。
 * 输入说明：正文和引用必须属于同一快照，缺失或损坏附件使整个导出失败。
 * 输出说明：返回 ZIP 字节，不写本地文件或触发下载。
 * 实现思路：读取并校验实际引用，以固定清单记录格式及摘要。
 */
export async function exportBundle(options: ExportBundleOptions): Promise<Uint8Array> {
  const filename = options.filename ?? 'document.md';
  validateFilename(filename);
  const text = encoder.encode(options.text);
  if (text.length > MAX_TEXT_BYTES) throw invalid('完整文档中的 Markdown 不能超过 8 MiB。');
  const references = referencedAssets(options.text);
  const provided = new Map(options.assets.map(asset => [asset.path, asset]));
  const entries: AsyncZippable = { [filename]: [text, { level: 6 }] };
  let total = text.length;
  for (const asset of references) {
    const supplied = provided.get(asset.path);
    if (!supplied || !sameContent(supplied, asset)) throw invalid('正文图片引用与导出附件不一致。');
    const bytes = await verifyCanvasAssetBytes(await options.port.read(options.documentPath, asset), asset);
    total += bytes.length;
    if (total > MAX_CANVAS_BUNDLE_BYTES) throw invalid('完整文档包不能超过 128 MiB。');
    // 静态图片已经压缩；直接存储可避免重复压缩占用 CPU，正文在后台压缩。
    entries[asset.path] = [bytes, { level: 0 }];
  }
  const manifest: BundleManifest = { format: 'taskrail-markdown-bundle', version: 1, filename, assets: references };
  const encodedManifest = encoder.encode(JSON.stringify(manifest));
  if (encodedManifest.length > MAX_MANIFEST_BYTES) throw invalid('完整文档包清单过大。');
  entries[manifestName] = [encodedManifest, { level: 6 }];
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: 0 }, (error, result) => { error ? reject(error) : resolve(result); });
  });
  if (bytes.length > MAX_CANVAS_BUNDLE_BYTES) throw invalid('完整文档包不能超过 128 MiB。');
  return bytes;
}

/**
 * 函数职责：验证完整包并将附件写入目标文档目录。
 * 输入说明：ZIP 条目不允许目录逃逸；单图与包总大小均有上限。
 * 输出说明：完成所有附件保存后返回正文与原始文件名；失败不返回可提交正文。
 * 实现思路：先校验清单、字节摘要和引用完整性，再执行不可覆盖附件写入。
 */
export async function importBundle(options: ImportBundleOptions): Promise<{ text: string; filename: string }> {
  if (!options.bytes.length || options.bytes.length > MAX_CANVAS_BUNDLE_BYTES) throw invalid('完整文档包不能超过 128 MiB。');
  const names = new Set<string>();
  let total = 0;
  // 第一遍只读目录，不解压；先检查全部条目与原始长度，防止 ZIP 膨胀后才发现超限。
  unzipSync(options.bytes, { filter(entry) {
    validateEntry(entry);
    if (names.has(entry.name)) throw invalid('完整文档包包含重复条目。');
    names.add(entry.name); total += entry.originalSize;
    if (names.size > MAX_ASSETS + 2 || total > MAX_CANVAS_BUNDLE_BYTES) throw invalid('完整文档包解压后过大。');
    return false;
  } });
  const entries = await new Promise<Unzipped>((resolve, reject) => {
    unzip(options.bytes, (error, result) => { error ? reject(error) : resolve(result); });
  });
  const manifest = parseManifest(entries[manifestName]);
  const textBytes = entries[manifest.filename];
  if (!textBytes || textBytes.length > MAX_TEXT_BYTES) throw invalid('完整文档包缺少 Markdown 正文。');
  const text = decoder.decode(textBytes);
  const references = referencedAssets(text);
  const declared = new Map(manifest.assets.map(asset => [asset.path, asset]));
  if (names.size !== manifest.assets.length + 2 || references.length !== manifest.assets.length || declared.size !== manifest.assets.length) throw invalid('完整文档包附件清单与正文不一致。');
  for (const asset of references) {
    const listed = declared.get(asset.path);
    const bytes = entries[asset.path];
    if (!listed || !sameContent(listed, asset) || !bytes) throw invalid('完整文档包缺少正文引用的图片。');
    await verifyCanvasAssetBytes(bytes, asset);
  }
  // 所有不可信字节先完成校验，再开始持久化；失败允许留下可复用附件，但绝不发布正文。
  for (const asset of references) {
    const saved = await options.port.put(options.documentPath, entries[asset.path], asset.mimeType);
    if (!sameContent(saved, asset)) throw invalid('图片保存结果与正文引用不一致。');
    await verifyCanvasAssetBytes(await options.port.read(options.documentPath, asset), asset);
  }
  return { text, filename: manifest.filename };
}

function invalid(message: string): Error { return Object.assign(new Error(message), { code: 'CANVAS_BUNDLE_INVALID' }); }

function validateFilename(filename: string): void {
  if (filename.length > 240 || !/^[^/\\:\0<>"|?*]+\.md$/i.test(filename)) throw invalid('完整文档包的 Markdown 文件名无效。');
}

function sameContent(first: CanvasAsset, second: CanvasAsset): boolean {
  return first.id === second.id && first.path === second.path && first.size === second.size && first.mimeType === second.mimeType;
}

/** 每个块都检查引用；同一路径出现冲突元数据时不能由后一个块悄悄覆盖。 */
function referencedAssets(text: string): CanvasAsset[] {
  const assets = new Map<string, CanvasAsset>();
  for (const block of scanCanvasBlocks(text)) {
    for (const asset of Object.values(block.document?.files ?? {})) {
      validateCanvasAsset(asset);
      const previous = assets.get(asset.path);
      if (previous && !sameContent(previous, asset)) throw invalid('同一图片路径具有冲突的引用。');
      assets.set(asset.path, asset);
    }
  }
  if (assets.size > MAX_ASSETS) throw invalid('单个完整文档包最多包含 1024 张图片。');
  return [...assets.values()];
}

function validateEntry(entry: UnzipFileInfo): void {
  const asset = /^\.assets\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(entry.name);
  if (!asset && entry.name !== manifestName) validateFilename(entry.name);
  const maximum = asset ? MAX_CANVAS_IMAGE_BYTES : entry.name === manifestName ? MAX_MANIFEST_BYTES : MAX_TEXT_BYTES;
  if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > maximum
    || ![0, 8].includes(entry.compression)) throw invalid('完整文档包条目格式或大小无效。');
}

function parseManifest(bytes: Uint8Array | undefined): BundleManifest {
  if (!bytes || bytes.length > MAX_MANIFEST_BYTES) throw invalid('完整文档包缺少清单。');
  let value: unknown;
  try { value = JSON.parse(decoder.decode(bytes)); } catch { throw invalid('完整文档包清单格式无效。'); }
  if (!value || typeof value !== 'object') throw invalid('完整文档包清单格式无效。');
  const manifest = value as BundleManifest;
  if (manifest.format !== 'taskrail-markdown-bundle' || manifest.version !== 1 || typeof manifest.filename !== 'string'
    || !Array.isArray(manifest.assets) || manifest.assets.length > MAX_ASSETS) throw invalid('完整文档包版本或清单格式不受支持。');
  validateFilename(manifest.filename);
  for (const asset of manifest.assets) validateCanvasAsset(asset);
  return manifest;
}
