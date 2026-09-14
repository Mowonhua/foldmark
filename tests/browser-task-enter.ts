/** 文件职责：提供真实浏览器键盘验收入口，展示两种模式每次输入后的源文和光标坐标。 */
import { EditorController } from '../src/lib/editor';
import { paragraphAt, paragraphLayout } from '../src/lib/editor/paragraphs';

const first = '- [ ] 设计完整的UI/UX';
const text = first + '\n- [ ] 迁移UI\n- [ ] 确认法阵模型\n- [ ] 优化世界体素';
const output = document.querySelector<HTMLElement>('#result')!;
let editor: EditorController;

function report(): void {
  output.textContent = JSON.stringify({ mode: editor.getUIState().mode, text: editor.text, cursor: editor.state.selection.main.head }, null, 2);
}

function reset(mode: 'todo' | 'source'): void {
  editor?.destroy();
  editor = new EditorController(document.querySelector<HTMLElement>('#editor')!, { text, mode, onChange: () => queueMicrotask(report) });
  editor.focusAt(first.length);
  report();
}

document.querySelector('#todo')!.addEventListener('click', () => reset('todo'));
document.querySelector('#source')!.addEventListener('click', () => reset('source'));
document.querySelector('#toggle-source')!.addEventListener('click', () => { editor.toggleSource(); report(); });
document.querySelector('#measure')!.addEventListener('click', async () => {
  await document.fonts.ready;
  for (let frame = 0; frame < 2; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const cursor = editor.state.selection.main.head;
  const line = editor.state.doc.lineAt(cursor);
  const layout = paragraphLayout(editor.state);
  const paragraph = layout.paragraphs[paragraphAt(layout, cursor)];
  const item = paragraph?.item;
  const contentFrom = item && line.from === item.moveFrom ? item.contentFrom : line.from + (line.text.match(/^[ \t]*/)?.[0].length ?? 0);
  document.querySelector('#metrics')!.textContent = JSON.stringify({
    cursor, paragraph: paragraph?.kind, paragraphs: layout.paragraphs.length,
    cursorLeft: editor.view.coordsAtPos(cursor)?.left,
    contentLeft: editor.view.coordsAtPos(contentFrom)?.left,
    taskContentLeft: item ? editor.view.coordsAtPos(item.contentFrom)?.left : null,
    visibleLines: [...editor.view.contentDOM.querySelectorAll('.cm-line')].map(line => ({ text: line.textContent, height: line.getBoundingClientRect().height })),
  }, null, 2);
});
reset('todo');
