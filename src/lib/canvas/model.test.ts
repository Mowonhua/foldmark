/** 文件职责：验证画布快照的保留边界和 Markdown 附件提取。 */
import { describe, expect, it } from 'vitest';
import { canvasAssetsFromText, createCanvasDocument, parseCanvasDocument, serializeCanvasDocument } from './model';
import type { CanvasAsset } from './types';

const id = 'a'.repeat(64);
const asset: CanvasAsset = { id, path: `.assets/${id}.png`, mimeType: 'image/png', size: 16, created: 0 };
const rectangle = { id: 'shape', type: 'rectangle', x: 1, y: 2, width: 30, height: 40, customData: { keep: true } };

describe('画布持久化格式', () => {
  it('空画布独立分配身份，整个快照保留引擎字段并序列化为单行', () => {
    const canvas = createCanvasDocument('草图\n二');
    expect(canvas.id).not.toBe(createCanvasDocument().id);
    canvas.elements = [rectangle];
    const source = serializeCanvasDocument(canvas);
    expect(source.split('\n')).toHaveLength(1);
    expect(parseCanvasDocument(source)).toEqual(canvas);
  });

  it.each([
    '{"version":',
    JSON.stringify({ version: 2, id: 'future', title: '', elements: [], files: {} }),
    JSON.stringify({ version: 1, id: 'unknown', title: '', elements: [{ ...rectangle, type: 'iframe' }], files: {} }),
    JSON.stringify({ version: 1, id: 'missing', title: '', elements: [{ ...rectangle, type: 'image', fileId: 'missing' }], files: {} }),
  ])('损坏或不支持的快照不被降级打开：%s', source => {
    expect(parseCanvasDocument(source)).toBeNull();
  });

  it('附件路径必须被摘要约束，序列化拒绝非法持久化数据', () => {
    const canvas = createCanvasDocument();
    canvas.files = { image: { ...asset, path: '../escape.png' } };
    expect(() => serializeCanvasDocument(canvas)).toThrow();
    canvas.files = { image: { ...asset } };
    canvas.elements = [{ ...rectangle, type: 'image', fileId: 'image' }];
    expect(parseCanvasDocument(serializeCanvasDocument(canvas))?.files.image).toEqual(asset);
    (canvas.files.image as unknown as Record<string, unknown>).dataURL = 'data:image/png;base64,AAAA';
    expect(() => serializeCanvasDocument(canvas)).toThrow();
  });

  it('只提取顶层和列表内完整的 canvas 围栏，按路径去重', () => {
    const canvas = createCanvasDocument(); canvas.files = { image: asset };
    const source = serializeCanvasDocument(canvas);
    const text = `\`\`\`canvas\n${source}\n\`\`\`\n\n- 条目\n\n  \`\`\`canvas\n  ${source}\n  \`\`\`\n\n\`\`\`json\n${source}\n\`\`\`\n\n\`\`\`canvas\n${source}`;
    expect(canvasAssetsFromText(text)).toEqual([asset]);
  });
});
