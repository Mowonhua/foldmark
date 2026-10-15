/** 文件职责：在真实布局中验证选区不覆盖行间留白，且多行代码高亮不越过代码框。 */
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
  const gapScenarios = [
    { name: 'task-lines', text: '- [ ] 适配npx skills标准安装\n- [ ] 下一行内容' },
    { name: 'nested-tasks', text: '- [ ] 适配npx skills标准安装\n  - [ ] 下一行内容\n  - [ ] 第三行内容' },
    { name: 'wrapped-task', text: `- [ ] 适配npx skills标准安装${'内容较长的任务标题'.repeat(12)}\n- [ ] 下一行内容` },
    { name: 'paragraphs', text: '普通正文第一行\n第二行内容\n第三行' },
    { name: 'heading', text: '# 标题内容\n普通正文' },
    { name: 'block-gap', text: '- [ ] 任务内容\n  > 引用正文' },
  ];
  for (const scenario of gapScenarios) for (const mode of ['todo', 'source'] as const) for (const reverse of [false, true]) for (const scale of [1, .8]) {
    document.querySelector<HTMLElement>('#editor')!.style.transform = `scale(${scale})`;
    editor.setMode(mode);
    const text = scenario.text;
    editor.setText(text, true);
    const from = text.indexOf('skills') >= 0 ? text.indexOf('skills') : text.indexOf('内容') >= 0 ? text.indexOf('内容') : 1;
    const to = text.length - 1;
    editor.view.dispatch({ selection: { anchor: reverse ? to : from, head: reverse ? from : to } });
    await settle();
    const textBounds = [...editor.view.contentDOM.querySelectorAll('.fm-selected')].flatMap(selected => {
      const range = document.createRange();
      range.selectNodeContents(selected);
      return [...range.getClientRects()].filter(rect => rect.width > 0);
    }).sort((a, b) => a.top - b.top);
    const gaps: { top: number; bottom: number }[] = [];
    let bottom = textBounds[0].bottom;
    for (const bounds of textBounds.slice(1)) {
      if (bounds.top > bottom + .5) gaps.push({ top: bottom, bottom: bounds.top });
      bottom = Math.max(bottom, bounds.bottom);
    }
    const markers = [...editor.view.dom.querySelectorAll('.fm-selectionLayer .cm-selectionBackground')].map(marker => marker.getBoundingClientRect());
    const coversText = textBounds.every(text => markers.some(marker => marker.top <= text.top + .5 && marker.bottom >= text.bottom - .5 && marker.left < text.right && marker.right > text.left));
    results.push({ scenario: scenario.name, mode, reverse, scale, gapCount: gaps.length,
      pass: gaps.length > 0 && coversText && !markers.some(marker => gaps.some(gap => marker.top < gap.bottom - .5 && marker.bottom > gap.top + .5)) && editor.text === text });
  }
  document.querySelector<HTMLElement>('#editor')!.style.transform = '';
  for (const mode of ['todo', 'source'] as const) {
    editor.setMode(mode);
    editor.setText('普通正文单行选区', true);
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
