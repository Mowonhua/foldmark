/** 文件职责：提供真实控件完成、排序、折叠、归档和恢复的浏览器验收入口。 */
import { EditorController } from '../src/lib/editor';
import { foldsField } from '../src/lib/editor/state';
import { applyTheme, builtInThemes } from '../src/lib/themes';
import '../src/app.css';

applyTheme(document.documentElement, builtInThemes[0], 'light', false);

const themeSelect = document.querySelector<HTMLSelectElement>('#theme')!;
for (const theme of builtInThemes) themeSelect.add(new Option(theme.name, theme.id));
const appearanceSelect = document.querySelector<HTMLSelectElement>('#appearance')!;
const switchTheme = () => applyTheme(document.documentElement, builtInThemes.find(theme => theme.id === themeSelect.value)!, appearanceSelect.value as 'light' | 'dark', false);
themeSelect.addEventListener('change', switchTheme);
appearanceSelect.addEventListener('change', switchTheme);

const sample = '- [ ] 父任务\n  - [ ] 甲\n    甲的说明正文\n  - [ ] 乙\n    乙的说明正文\n  - [ ] 待处理\n  - [x] 旧完成\n    旧完成说明\n\n- [ ] 长笔记\n  独立任务的说明正文\n\n# 归档\n\n- [x] 旧归档\n  归档说明\n';
const hierarchySample = '# 工作\n\n## 本周\n\n### 开发\n\n- [ ] 发布清单\n  保留任务正文\n  - [x] 校对文件\n\n- [ ] 后续工作\n\n# 笔记\n\n- [ ] 留在笔记\n';
const output = document.querySelector<HTMLElement>('#result')!;
let editor: EditorController;
const report = () => { output.textContent = JSON.stringify({ mode: editor.getUIState().mode, text: editor.text, folded: [...editor.state.field(foldsField)] }, null, 2); };
const reset = (text = sample) => {
  editor?.destroy();
  editor = new EditorController(document.querySelector<HTMLElement>('#editor')!, { text, mode: 'todo', onChange: () => queueMicrotask(report), onUIChange: () => queueMicrotask(report) });
  report();
};
document.querySelector('#reset')!.addEventListener('click', () => reset());
document.querySelector('#hierarchy')!.addEventListener('click', () => reset(hierarchySample));
document.querySelector('#todo')!.addEventListener('click', () => { editor.setMode('todo'); report(); });
document.querySelector('#archive')!.addEventListener('click', () => { editor.setMode('archive'); report(); });
document.querySelector('#source')!.addEventListener('click', () => { editor.toggleSource(); report(); });
document.querySelector('#undo')!.addEventListener('click', () => { editor.undo(); report(); });
document.querySelector('#redo')!.addEventListener('click', () => { editor.redo(); report(); });
reset();
