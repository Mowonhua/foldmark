/** 文件职责：在真实布局下验证空段落、任务正文及代码块文末的右键插入。 */
import { EditorController } from '../src/lib/editor';
import { applyTheme, builtInThemes } from '../src/lib/themes';
import '../src/app.css';

applyTheme(document.documentElement, builtInThemes[0], 'light', false);
const samples = {
  blank: '前一段\n\n\n\n后一段',
  task: '- [ ] root\n  任务正文\n  - child',
  block: '```\nx\n```',
};
const output = document.querySelector<HTMLElement>('#result')!;
const editor = new EditorController(document.querySelector<HTMLElement>('#editor')!, {
  text: samples.blank, mode: 'todo', onChange: text => output.textContent = text,
});
output.textContent = samples.blank;
for (const [id, text] of Object.entries(samples)) {
  document.querySelector(`#${id}`)!.addEventListener('click', () => {
    editor.setText(text, true); output.textContent = text;
    editor.focusAt(text.length);
  });
}
document.querySelector('#undo')!.addEventListener('click', () => editor.undo());
