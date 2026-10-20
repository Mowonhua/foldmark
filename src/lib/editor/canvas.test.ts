/** 文件职责：验证画布卡片、局部提交和跨文档会话隔离。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorController, type EditorOptions } from './index';
import { createCanvasDocument, scanCanvasBlocks, serializeCanvasDocument } from '../canvas/model';
import type { CanvasDocument, CanvasSession } from '../canvas/types';
import { CanvasSaveQueue } from '../canvas/save-queue';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const editors: EditorController[] = [];
function editor(text: string, options: Partial<EditorOptions> = {}): EditorController {
  const parent = document.createElement('div'); document.body.append(parent);
  const instance = new EditorController(parent, { text, mode: 'todo', onChange: () => {}, ...options });
  editors.push(instance); return instance;
}
const fence = (canvas: CanvasDocument) => `\`\`\`canvas\n${serializeCanvasDocument(canvas)}\n\`\`\``;
afterEach(() => { for (const instance of editors.splice(0)) instance.destroy(); document.body.replaceChildren(); });

describe('Markdown 内嵌画布', () => {
  it('右键插入菜单复用画布命令并直接打开，一次撤销恢复原文', () => {
    const opened = vi.fn();
    const source = '# 清单\n\n正文\n';
    const instance = editor(source, { openCanvas: opened });
    vi.spyOn(instance.view, 'posAtCoords').mockReturnValue(8);
    instance.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    document.querySelector<HTMLButtonElement>('[data-submenu="insert"]')!.click();
    const action = document.querySelector<HTMLButtonElement>('[data-command="insertCanvas"]')!;
    expect(action.getAttribute('aria-disabled')).toBe('false'); action.click();
    expect(opened).toHaveBeenCalledOnce();
    expect(scanCanvasBlocks(instance.text)).toHaveLength(1);
    expect(document.querySelector('.fm-context-menu')).toBeNull();
    expect(instance.undo()).toBe(true); expect(instance.text).toBe(source);
    vi.restoreAllMocks();
  });
  it.each(['todo', 'source'] as const)('待办的 %s 隐藏归档光标插入画布时落在归档标题前', mode => {
    const opened = vi.fn();
    const source = '# 清单\n\n- [ ] 待办\n\n# 归档\n\n- [x] 旧任务\n';
    const instance = editor(source, { openCanvas: opened });
    if (mode === 'source') instance.setMode('source');
    instance.view.dispatch({ selection: { anchor: instance.text.length } });
    expect(instance.insertCanvas()).toBe(true);
    const block = scanCanvasBlocks(instance.text)[0];
    expect(block.to).toBeLessThan(instance.text.indexOf('# 归档'));
    expect(instance.text.slice(instance.text.indexOf('# 归档'))).toBe('# 归档\n\n- [x] 旧任务\n');
    if (mode === 'todo') expect(instance.view.dom.querySelector('.fm-canvas-card')).not.toBeNull();
    expect(instance.undo()).toBe(true); expect(instance.text).toBe(source);
  });
  it('默认标题开头的光标可在标题后插入画布，保留原标题与后续正文', () => {
    const opened = vi.fn();
    const instance = editor('# 欢迎\n\n- [ ] 开始使用\n', { openCanvas: opened });
    instance.view.dispatch({ selection: { anchor: 0 } });
    expect(instance.insertCanvas()).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(instance.text).toMatch(/^# 欢迎\n\n```canvas\n/);
    expect(instance.text).toContain('- [ ] 开始使用');
    expect(instance.undo()).toBe(true); expect(instance.text).toBe('# 欢迎\n\n- [ ] 开始使用\n');
  });
  it('插入画布后即时打开，卡片在光标内保持折叠，源码显示完整文本，插入一次撤销', () => {
    let session: CanvasSession | undefined;
    const instance = editor('正文', { openCanvas: value => { session = value; } });
    instance.view.dispatch({ selection: { anchor: 2 } });
    expect(instance.insertCanvas()).toBe(true);
    expect(session?.document.elements).toEqual([]);
    expect(instance.view.dom.querySelector('.fm-canvas-card')).not.toBeNull();
    const block = scanCanvasBlocks(instance.text)[0];
    instance.view.dispatch({ selection: { anchor: block.bodyFrom + 5 } });
    expect(instance.view.dom.querySelector('.fm-canvas-card')).not.toBeNull();
    instance.setMode('source');
    expect(instance.view.dom.querySelector('.fm-canvas-card')).toBeNull();
    expect(instance.view.dom.textContent).toContain('```canvas');
    expect(instance.undo()).toBe(true); expect(instance.text).toBe('正文');
  });

  it('同 ID 的两个块只更新被打开的范围，块前插入文字后仍命中原块', () => {
    let session!: CanvasSession;
    const canvas = createCanvasDocument('原图');
    const source = fence(canvas);
    const instance = editor(`${source}\n\n${source}`, { openCanvas: value => { session = value; } });
    const cards = instance.view.dom.querySelectorAll<HTMLButtonElement>('.fm-canvas-expand');
    cards[1].click();
    instance.view.dispatch({ changes: { from: 0, insert: '前言\n\n' } });
    expect(session.commit({ ...session.document, title: '后图' })).toBe(true);
    expect(scanCanvasBlocks(instance.text).map(block => block.document?.title)).toEqual(['原图', '后图']);
    expect(instance.undo()).toBe(true);
    expect(scanCanvasBlocks(instance.text).map(block => block.document?.title)).toEqual(['原图', '原图']);
  });

  it('外部改写或删除后拒绝旧提交，即使撤销回来也不能复活旧会话', () => {
    let session!: CanvasSession;
    const instance = editor(fence(createCanvasDocument('原图')), { openCanvas: value => { session = value; } });
    instance.view.dom.querySelector<HTMLButtonElement>('.fm-canvas-expand')!.click();
    const block = scanCanvasBlocks(instance.text)[0];
    instance.view.dispatch({ changes: { from: block.bodyFrom, to: block.bodyTo, insert: '{}' } });
    expect(session.commit({ ...session.document, title: '覆盖' })).toBe(false);
    instance.undo();
    expect(session.commit({ ...session.document, title: '覆盖' })).toBe(false);
    expect(instance.text).toContain('原图');
  });

  it('相同正文切换文档仍使会话失效，旧 close 不干扰新文档', () => {
    let session!: CanvasSession;
    const instance = editor(fence(createCanvasDocument()), { openCanvas: value => { session = value; } });
    instance.view.dom.querySelector<HTMLButtonElement>('.fm-canvas-expand')!.click();
    instance.restoreState(instance.createState(instance.text, 'todo'));
    const before = instance.text;
    expect(session.commit({ ...session.document, title: '其他文档' })).toBe(false);
    session.close(); expect(instance.text).toBe(before);
  });

  it('删除原块后在同处粘贴相同快照，也不把旧会话移交给新块', () => {
    let session!: CanvasSession;
    const source = fence(createCanvasDocument());
    const instance = editor(source, { openCanvas: value => { session = value; } });
    instance.view.dom.querySelector<HTMLButtonElement>('.fm-canvas-expand')!.click();
    instance.view.dispatch({ changes: { from: 0, to: instance.text.length, insert: source } });
    expect(session.commit({ ...session.document, title: '旧会话' })).toBe(false);
    expect(instance.text).toBe(source);
  });

  it('多行快照第一次保存归并成一行，连续提交和关闭仍保留图片恢复引用', () => {
    let session!: CanvasSession;
    const canvas = createCanvasDocument();
    const id = 'b'.repeat(64);
    canvas.files = { image: { id, path: `.assets/${id}.png`, mimeType: 'image/png', size: 32, created: 0 } };
    const source = `\`\`\`canvas\n${JSON.stringify(canvas, null, 2)}\n\`\`\``;
    const instance = editor(source, { openCanvas: value => { session = value; } });
    instance.view.dom.querySelector<HTMLButtonElement>('.fm-canvas-expand')!.click();
    expect(session.commit({ ...session.document, title: '一', files: {} })).toBe(true);
    expect(session.commit({ ...session.document, title: '二', files: {} })).toBe(true);
    const block = scanCanvasBlocks(instance.text)[0];
    expect(instance.text.slice(block.bodyFrom, block.bodyTo).split('\n')).toHaveLength(1);
    expect(block.document?.files.image.path).toBe(`.assets/${id}.png`);
    session.close();
    expect(session.commit({ ...session.document, title: '关闭后' })).toBe(false);
    expect(instance.undo()).toBe(true);
    expect(scanCanvasBlocks(instance.text)[0].document?.title).toBe('一');
  });

  it('保存队列传入引擎的 undefined 默认字段时，真实会话仍能提交并保留图形', async () => {
    let session!: CanvasSession;
    const instance = editor(fence(createCanvasDocument()), { openCanvas: value => { session = value; } });
    instance.view.dom.querySelector<HTMLButtonElement>('.fm-canvas-expand')!.click();
    const queue = new CanvasSaveQueue({ session, documentPath: '/notes/doc.md', assets: { put: vi.fn(), read: vi.fn() }, onStatus: vi.fn() });
    queue.update({ title: '引擎默认值', files: {}, elements: [{ id: 'rectangle', type: 'rectangle', x: 2, y: 3, width: 80, height: 40,
      angle: 0, strokeColor: '#1b1b1f', backgroundColor: 'transparent', strokeWidth: 1, strokeStyle: 'solid', fillStyle: 'hachure',
      roughness: 0, opacity: 100, seed: 10, version: 1, versionNonce: 20, isDeleted: false, groupIds: [], frameId: null,
      boundElements: null, updated: 0, link: null, locked: false, roundness: undefined, customData: undefined }] });
    try {
      expect(await queue.flush()).toBe(true);
      const document = scanCanvasBlocks(instance.text)[0].document!;
      expect(document.title).toBe('引擎默认值');
      expect(document.elements[0]).toMatchObject({ id: 'rectangle', type: 'rectangle', x: 2, width: 80 });
      expect(Object.hasOwn(document.elements[0], 'roundness')).toBe(false);
      expect(Object.hasOwn(document.elements[0], 'customData')).toBe(false);
    } finally { queue.dispose(); }
  });

  it('列表内插入保留容器，归档可打开只读会话，坏格式保持原文', () => {
    const opened = vi.fn();
    const instance = editor('- [ ] 工作', { openCanvas: opened });
    instance.view.dispatch({ selection: { anchor: instance.text.length } });
    expect(instance.insertCanvas()).toBe(true);
    expect(instance.text).toContain('\n  ```canvas\n  {');
    expect(scanCanvasBlocks(instance.text)).toHaveLength(1);
    instance.setText(`- [x] 完成\n\n  ${fence(createCanvasDocument()).replaceAll('\n', '\n  ')}`);
    instance.setMode('archive');
    instance.view.dom.querySelector<HTMLButtonElement>('.fm-canvas-expand')!.click();
    const session = opened.mock.calls.at(-1)![0] as CanvasSession;
    expect(session.readOnly).toBe(true); expect(session.commit(session.document)).toBe(false);
    instance.setMode('todo'); instance.setText('```canvas\n{"version":2}\n```');
    expect(instance.view.dom.querySelector('.fm-canvas-card')).toBeNull();
    expect(instance.text).toBe('```canvas\n{"version":2}\n```');
  });
});
