/** 文件职责：通过真实浏览器几何验证任务内块缩进与公式前间距，补足 jsdom 的布局边界。 */
import { EditorController } from '../src/lib/editor';

const nestedText = '- [ ] 标题\n  ```\n  ggg = fun()\n  ```\n\n  $$\n  a=b\n  $$\n\n  > 引用\n\n  - [ ] 子任务\n    ```\n    nested()\n    ```\n\n    $$\n    x=y\n    $$\n\n末尾';
const compactBlocks = ['- [ ] 标题', '  ```\n  hell\n  ```', '  > faf', '  ```\n  import pydantic\n\n  s\n  ```', '  $$\n  a=b_i\n  $$'];
const scenarios: Record<string, string> = { nested: nestedText, compact: compactBlocks.join('\n') + '\n\n末尾', spaced: compactBlocks.join('\n\n') + '\n\n末尾' };
let text = nestedText;
const editor = new EditorController(document.querySelector<HTMLElement>('#editor')!, { text, mode: 'todo', onChange: () => {} });
editor.focusAt(text.length);
document.querySelector('#theme')!.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.cssText = dark ? '--surface:#222720;--surface-alt:#30382e;--text:#e4e9df;--muted:#97a391;--accent:#a2ba96;background:#222720;color:#e4e9df' : '';
});
for (const [name, source] of Object.entries(scenarios)) {
  document.querySelector(`#${name}`)!.addEventListener('click', () => {
    text = source;
    editor.setText(source, true);
    editor.focusAt(source.length);
    document.querySelector('#result')!.textContent = '';
  });
}

document.querySelector('#measure')!.addEventListener('click', () => {
  const entries = [...editor.view.contentDOM.children].map(element => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { className: element.className, text: element.textContent, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, margin: style.margin, padding: style.padding, lineHeight: style.lineHeight };
  });
  const head = editor.state.selection.main.head;
  document.querySelector('#result')!.textContent = JSON.stringify({ selection: { head, line: editor.state.doc.lineAt(head).text }, unchanged: editor.text === text, entries }, null, 2);
});
