/** 文件职责：在真实布局中核对左键命中的文本行与编辑器选区，补足 jsdom 无几何布局的边界。 */
import { EditorController } from '../src/lib/editor';

const text = '# 标题\n\n- [ ] 第一项\n- [ ] 第二项\n- [ ] 第三项\n\n## 第二节\n\n第二节正文\n\n正文末尾';
const editor = new EditorController(document.querySelector<HTMLElement>('#editor')!, { text, mode: 'todo', onChange: () => {} });
editor.focusAt(text.length);
editor.view.contentDOM.addEventListener('mousedown', event => {
  if (event.button !== 0) return;
  const line = (event.target as Element).closest('.cm-line');
  const expected = line?.textContent?.replace(/[▾▸]/g, '').trim();
  // 在 CodeMirror 完成本次鼠标事务后读取选区；预期来自点击前的 DOM 行，避免自证。
  requestAnimationFrame(() => {
    const actual = editor.state.doc.lineAt(editor.state.selection.main.head).text;
    document.querySelector('#result')!.textContent = JSON.stringify({ expected, actual, pass: !!expected && actual.includes(expected) });
  });
}, true);
