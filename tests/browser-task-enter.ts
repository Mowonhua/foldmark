/** 文件职责：提供真实浏览器键盘验收入口，展示两种模式每次输入后的源文和光标坐标。 */
import { EditorController } from '../src/lib/editor';

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
reset('todo');
