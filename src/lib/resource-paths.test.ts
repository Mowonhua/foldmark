/** 文件职责：验证图片路径相对于 Markdown 文件而不是应用安装目录解析。 */
import { describe, expect, it } from 'vitest';
import { resolveDocumentResource } from './resource-paths';
const convert = (path: string) => `asset:${path}`;
describe('文档资源定位', () => {
  it('解析中文相对路径、父目录与编码空格', () => {
    expect(resolveDocumentResource('D:\\项目\\docs\\清单.md', '../images/示意%20图.png', convert)).toBe('asset:D:/项目/images/示意 图.png');
  });
  it('保留网络链接和数学渲染之外的数据图片', () => {
    expect(resolveDocumentResource('D:/清单.md', 'https://example.com/a.png', convert)).toBe('https://example.com/a.png');
    expect(resolveDocumentResource('D:/清单.md', 'data:image/png;base64,YQ==', convert)).toBe('data:image/png;base64,YQ==');
    expect(resolveDocumentResource('D:/清单.md', '#小节', convert)).toBe('#小节');
    expect(resolveDocumentResource('D:/清单.md', '//example.com/a.png', convert)).toBe('https://example.com/a.png');
  });
  it('正确处理盘符绝对路径与 UNC 共享', () => {
    expect(resolveDocumentResource('D:/docs/list.md', 'C:\\图\\a.png', convert)).toBe('asset:C:/图/a.png');
    expect(resolveDocumentResource('D:/docs/list.md', 'file:///C:/图/a.png', convert)).toBe('asset:C:/图/a.png');
    expect(resolveDocumentResource('\\\\server\\share\\docs\\list.md', '../a.png', convert)).toBe('asset://server/share/a.png');
  });
  it('包含百分号的合法文件名不让中文目录解析失败', () => {
    expect(resolveDocumentResource('D:/项目/清单.md', '完成100%.png', convert)).toBe('asset:D:/项目/完成100%.png');
  });
});
