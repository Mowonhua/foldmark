/**
 * 文件职责：在原生附件目录与浏览器 IndexedDB 中保存不可变画布图片。
 * 定义范围：附件边界校验、内容寻址、平台端口与二进制读取。
 */
import type { CanvasAsset, CanvasAssetPort, CanvasImageMime } from './types';
import { invoke } from '@tauri-apps/api/core';

export const MAX_CANVAS_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_NATIVE_EXPORT_BYTES = 128 * 1024 * 1024;
const extensions: Record<CanvasImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function invalid(message: string): Error { return Object.assign(new Error(message), { code: 'CANVAS_ASSET_INVALID' }); }

/**
 * 函数职责：验证正文或同步消息中的图片引用。
 * 输入说明：引用必须使用内容摘要命名，路径只允许 .assets/ 下的单级文件。
 * 输出说明：非法引用抛错，不接触持久化数据。
 * 实现思路：同时检查摘要、格式、尺寸与标准相对路径。
 */
export function validateCanvasAsset(asset: unknown): asserts asset is CanvasAsset {
  if (!asset || typeof asset !== 'object') throw invalid('画布图片引用无效。');
  const value = asset as CanvasAsset;
  if (typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id)
    || !Object.hasOwn(extensions, value.mimeType) || typeof value.path !== 'string'
    || !Number.isInteger(value.size) || value.size <= 0 || value.size > MAX_CANVAS_IMAGE_BYTES
    || !Number.isFinite(value.created) || value.created < 0) throw invalid('画布图片引用无效。');
  if (value.path !== `.assets/${value.id}.${extensions[value.mimeType]}`) throw invalid('画布图片路径无效。');
}

/**
 * 函数职责：核验导入图片的格式与资源上限。
 * 输入说明：只接收 PNG、JPEG、WebP，单张不超过 20 MiB。
 * 输出说明：格式声明与文件头不匹配时抛错。
 * 实现思路：检查长度与格式签名，完整解码由白板引擎负责。
 */
export function validateCanvasImage(bytes: Uint8Array, mimeType: CanvasImageMime): void {
  if (!Object.hasOwn(extensions, mimeType)) throw invalid('仅支持 PNG、JPEG 和 WebP 图片。');
  if (bytes.length === 0 || bytes.length > MAX_CANVAS_IMAGE_BYTES) throw invalid('单张图片不能超过 20 MiB。');
  const matches = mimeType === 'image/png'
    ? bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    : mimeType === 'image/jpeg'
      ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  if (!matches) throw invalid('图片格式与文件内容不匹配。');
}

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 函数职责：验证完整图片字节与引用的一致性。
 * 输入说明：bytes 来自磁盘、IndexedDB、完整包或同步分块组装结果。
 * 输出说明：成功返回原始字节，格式、大小、摘要或路径错误均抛错。
 * 实现思路：先验证引用和格式，再对完整字节计算 SHA-256；不使用旧缓存掩盖损坏。
 */
export async function verifyCanvasAssetBytes(bytes: Uint8Array, asset: CanvasAsset): Promise<Uint8Array> {
  validateCanvasAsset(asset);
  validateCanvasImage(bytes, asset.mimeType);
  if (bytes.length !== asset.size || await digest(bytes) !== asset.id) throw invalid('画布图片已损坏或摘要不匹配。');
  return bytes;
}

/** 浏览器没有磁盘规范路径；以归一化后的父目录作为共享命名空间。 */
function namespace(documentPath: string): string {
  if (!documentPath || documentPath.includes('\0') || /[\\/]$/.test(documentPath)) throw invalid('请先创建或打开 Markdown 文档。');
  const normalized = documentPath.replace(/\\/g, '/');
  const parts = normalized.split('/'); parts.pop();
  const directory: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..' && directory.length && directory.at(-1) !== '..') { directory.pop(); continue; }
    directory.push(part);
  }
  const joined = directory.join('/');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? joined.toLowerCase() : joined;
}

/** 结构职责：将引用和原始二进制一起提交，避免正文拿到尚未写完的附件。 */
interface StoredAsset { asset: CanvasAsset; bytes: Uint8Array }
let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('taskrail-canvas-assets', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('images'); };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error ?? invalid('图片存储不可用。')); };
    request.onblocked = () => { database = undefined; reject(invalid('图片存储被其他窗口阻塞。')); };
  });
  return database;
}

/** 同一事务先读后写，重复内容保留首次创建时间；现存数据只读，损坏时也不覆盖。 */
async function stored(key: string, candidate?: StoredAsset): Promise<StoredAsset> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('images', candidate ? 'readwrite' : 'readonly');
    const store = transaction.objectStore('images');
    const request = store.get(key);
    let result: StoredAsset | undefined;
    request.onsuccess = () => {
      result = request.result as StoredAsset | undefined;
      if (!result && candidate) { result = candidate; store.add(candidate, key); }
    };
    transaction.oncomplete = () => { result ? resolve(result) : reject(invalid('画布图片附件缺失。')); };
    transaction.onerror = () => { reject(transaction.error ?? invalid('图片存储失败。')); };
    transaction.onabort = () => { reject(transaction.error ?? invalid('图片存储失败。')); };
  });
}

async function command<T>(name: string, args: Record<string, unknown> | Uint8Array, metadata?: Record<string, string>): Promise<T> {
  const options = metadata ? { headers: { 'x-taskrail-canvas': encodeURIComponent(JSON.stringify(metadata)) } } : undefined;
  try { return await invoke<T>(name, args, options); }
  catch (cause) {
    if (cause instanceof Error) throw cause;
    const detail = cause as { code?: string; message?: string } | null;
    throw Object.assign(new Error(detail?.message ?? String(cause)), { code: detail?.code ?? 'CANVAS_ASSET_IO' });
  }
}

/**
 * 函数职责：将系统选择路径的 PNG 或完整文档包作为二进制发送到原生端保存。
 * 输入说明：bytes 为调用方持有的完整快照，调用完成前不能改写；最大 128 MiB。
 * 输出说明：原子保存完成才返回；失败保留原始文件。
 * 实现思路：使用原始 IPC 请求体承载字节，以 ASCII 头传递路径元数据，避免数字数组与 JSON 膨胀。
 */
export async function nativeSaveCanvasFile(path: string, bytes: Uint8Array): Promise<void> {
  if (!bytes.length || bytes.length > MAX_NATIVE_EXPORT_BYTES) throw invalid('导出数据不能为空且不能超过 128 MiB。');
  await command<void>('save_canvas_bundle', bytes, { path });
}

/**
 * 函数职责：创建平台无关的不可变附件端口。
 * 输入说明：native 仅由应用的平台识别传入；documentPath 决定共享附件的父目录。
 * 输出说明：成功 put 后才可将引用写入正文；read 始终验证原始字节摘要。
 * 实现思路：原生调用后台磁盘命令，浏览器使用 IndexedDB 原子事务。
 */
export function createCanvasAssetPort(native: boolean): CanvasAssetPort {
  return {
    async put(documentPath, input, mimeType) {
      validateCanvasImage(input, mimeType);
      // 在首个 await 前复制；调用方可复用导入缓冲区，摘要与落盘必须使用同一份快照。
      const bytes = new Uint8Array(input);
      if (native) {
        const asset = await command<CanvasAsset>('put_canvas_asset', bytes, { documentPath, mimeType });
        validateCanvasAsset(asset);
        return asset;
      }
      const id = await digest(bytes);
      const candidate = { id, path: `.assets/${id}.${extensions[mimeType]}`, mimeType, size: bytes.length, created: Date.now() };
      const result = await stored(`${namespace(documentPath)}\0${candidate.path}`, { asset: candidate, bytes: new Uint8Array(bytes) });
      await verifyCanvasAssetBytes(new Uint8Array(result.bytes), result.asset);
      if (result.asset.path !== candidate.path || result.asset.id !== id) throw invalid('已保存的图片引用与附件内容不匹配。');
      return result.asset;
    },
    async read(documentPath, asset) {
      validateCanvasAsset(asset);
      const bytes = native
        ? new Uint8Array(await command<ArrayBuffer>('read_canvas_asset', { documentPath, asset }))
        : new Uint8Array((await stored(`${namespace(documentPath)}\0${asset.path}`)).bytes);
      return verifyCanvasAssetBytes(bytes, asset);
    },
  };
}
