/** 文件职责：在真实布局中验证多行代码选区不会越过代码框，覆盖嵌套、空行与软换行。 */
import { EditorController } from '../src/lib/editor';
import { RectangleMarker } from '@codemirror/view';

const editor = new EditorController(document.querySelector<HTMLElement>('#editor')!, {
  text: '', mode: 'todo', onChange: () => {},
});
const settle = async (): Promise<void> => {
  for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame);
};
document.querySelector('#sample')!.addEventListener('click', () => {
  editor.setMode('todo');
  editor.setText('- [ ] 示例\n  ```\n  ce = fff\n  fdasf\n  ```\n\n末尾', true);
  editor.focusAt(editor.text.indexOf('ce ='));
});
document.querySelector('#verify')!.addEventListener('click', async () => {
  const results: object[] = [];
  editor.setMode('todo');
  for (const indent of ['', '  ', '    ']) {
    for (const width of [1000, 480]) {
      for (const scale of [1, .8]) {
        const host = document.querySelector<HTMLElement>('#editor')!;
        host.style.width = `${width}px`;
        host.style.transform = `scale(${scale})`;
        host.style.transformOrigin = 'top left';
        const prefix = indent === '' ? '' : indent === '  ' ? '- [ ] 任务\n' : '- [ ] 任务\n  - [ ] 子任务\n';
        const text = `${prefix}${indent}\`\`\`\n${indent}ce = fff\n${indent}\n${indent}${'long_code '.repeat(16)}\n${indent}fdasf\n${indent}\`\`\`\n\n末尾`;
        editor.setText(text, true);
        editor.focusAt(text.indexOf('ce ='));
        editor.view.dispatch({ selection: { anchor: text.indexOf('ce ='), head: text.indexOf('fdasf') + 5 } });
        await settle();
        const rows = [...editor.view.dom.querySelectorAll('.fm-code-line')].map(row => row.getBoundingClientRect());
        const markers = [...editor.view.dom.querySelectorAll('.cm-selectionBackground')].filter(marker => getComputedStyle(marker).display !== 'none').map(marker => marker.getBoundingClientRect());
        const overflow = markers.some(marker => rows.some(row => marker.bottom > row.top + .5 && marker.top < row.bottom - .5 && (marker.left < row.left - .5 || marker.right > row.right + .5)));
        results.push({ indent: indent.length, width, scale, pass: markers.length > 0 && !overflow && editor.text === text });
      }
    }
  }
  document.querySelector<HTMLElement>('#editor')!.style.transform = '';
  for (const mode of ['todo', 'source'] as const) {
    editor.setMode(mode);
    editor.setText('普通正文第一行\n第二行内容\n第三行', true);
    editor.view.dispatch({ selection: { anchor: 1, head: editor.text.length - 1 } });
    await settle();
    const expected = RectangleMarker.forRange(editor.view, 'cm-selectionBackground', editor.state.selection.main);
    const actual = [...editor.view.dom.querySelectorAll<HTMLElement>('.fm-selectionLayer .cm-selectionBackground')];
    results.push({ mode, pass: actual.length === expected.length && actual.every((element, index) => {
      const rect = expected[index];
      return Math.abs(parseFloat(element.style.left) - rect.left) < .1 && Math.abs(parseFloat(element.style.top) - rect.top) < .1 && Math.abs(parseFloat(element.style.width) - rect.width!) < .1 && Math.abs(parseFloat(element.style.height) - rect.height) < .1;
    }) });
  }
  document.querySelector('#result')!.textContent = JSON.stringify(results, null, 2);
});
