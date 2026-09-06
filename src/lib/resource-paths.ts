/**
 * 文件职责：将 Markdown 相对资源定位到所属文档目录。
 * 定义范围：Windows 本地路径解析；协议白名单由编辑器与系统外链端口负责。
 */

/**
 * 函数职责：解析本地图片路径，并保留网络、数据及文档内锚点。
 * 输入说明：documentPath 来自文件关联，resource 来自 Markdown 链接；convert 由平台提供。
 * 输出说明：本地路径经过 convert，其他 URI 保持原值。
 * 实现思路：按文件 URL 规则合并父目录和相对路径，再转换为平台路径。
 */
export function resolveDocumentResource(documentPath: string, resource: string, convert: (path: string) => string): string {
  if (/^(?:https?:|mailto:|data:|#)/i.test(resource)) return resource;
  const document = documentPath.replace(/\\/g, '/');
  const target = resource.replace(/\\/g, '/');
  const base = document.startsWith('//') ? `file:${document}` : `file:///${document}`;
  const relative = /^[a-z]:\//i.test(target) ? `file:///${target}` : target;
  const url = new URL(relative, encodeURI(base).replace(/#/g, '%23').replace(/\?/g, '%3F'));
  let path = decodeURIComponent(url.pathname);
  if (/^\/[a-z]:/i.test(path)) path = path.slice(1);
  if (url.host) path = `//${url.host}${path}`;
  return convert(path);
}
