/** 文件职责：验证列表内块的布局投影、完整行替换和源码切换契约。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';
import { previewField } from './preview';
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });
it('列表内块沿容器缩进且整行替换公式，不留下前导空白行', () => {
  const text = '- [ ] 标题\n  ```\n  ggg = fun()\n  ```\n\n  $$\n  a=b\n  $$\n\n  > 引用\n\n  - [ ] 子项\n    ```\n      nested()\n    ```\n\n末尾';
  instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} });
  instance.focusAt(text.length);
  const code = [...instance.view.dom.querySelectorAll<HTMLElement>('.fm-code-start')];
  expect(code[0].style.marginLeft).not.toBe('');
  expect(code[1].style.marginLeft).not.toBe(code[0].style.marginLeft);
  expect(code[0].textContent).toBe('ggg = fun()');
  expect(code[1].textContent).toBe('  nested()');
  expect(instance.view.dom.querySelector<HTMLElement>('.fm-quote')!.style.marginLeft).toBe(code[0].style.marginLeft);
  expect(instance.view.dom.querySelector<HTMLElement>('.fm-math-block')!.style.marginLeft).toBe(code[0].style.marginLeft);
  const mathFrom = text.indexOf('  $$');
  let wholeLine = false;
  instance.state.field(previewField).between(mathFrom, mathFrom + 4, (from, to, value) => {
    if (value.spec.block && to > mathFrom + 4) wholeLine = from === mathFrom;
  });
  expect(wholeLine).toBe(true);
  instance.setMode('source');
  expect(instance.text).toBe(text);
  expect(instance.view.dom.querySelector('.fm-code-start')).toBeNull();
});

it('有序列表的表格和空围栏使用相同缩进，源码切换不改写内容', () => {
  const text = '10. 条目\n\n    | A | B |\n    | - | - |\n    | 1 | 2 |\n\n    ```\n    ```\n\n末尾';
  instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} });
  instance.focusAt(text.length);
  const table = instance.view.dom.querySelector<HTMLElement>('.fm-table-wrap')!;
  const code = instance.view.dom.querySelector<HTMLElement>('.fm-empty-code')!;
  expect(table.style.marginLeft).not.toBe('');
  expect(code.style.marginLeft).toBe(table.style.marginLeft);
  expect(table.querySelectorAll('td')).toHaveLength(2);
  instance.setMode('source');
  expect(instance.text).toBe(text);
});

it('同一位置从空代码块改成公式时重建正确的块控件', () => {
  const text = '- [ ] 标题\n  ```\n  ```\n\n末尾';
  instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} });
  instance.focusAt(text.length);
  const from = text.indexOf('```');
  instance.view.dispatch({ changes: { from, to: text.lastIndexOf('```') + 3, insert: '$$x=y$$' } });
  expect(instance.view.dom.querySelector('.fm-empty-code')).toBeNull();
  expect(instance.view.dom.querySelector('.fm-math-block .katex')).not.toBeNull();
});

it('相邻语义块不依赖源码空行获得间距，代码内部换行不插入块间距', () => {
  const text = '- [ ] 标题\n  ```\n  hell\n  ```\n  > faf\n  ```\n  import pydantic\n\n  s\n  ```\n  $$a=b_i$$\n\n末尾';
  instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} });
  instance.focusAt(text.length);
  expect(instance.view.dom.querySelectorAll('.fm-block-gap')).toHaveLength(4);
  expect([...instance.view.dom.querySelectorAll('.fm-code-line')].map(node => node.textContent)).toEqual(['hell', 'import pydantic', '', 's']);
  instance.focusAt(text.indexOf('a=b_i'));
  expect(instance.view.dom.querySelectorAll('.fm-block-gap')).toHaveLength(4);
  expect(instance.text).toBe(text);
  instance.setMode('source');
  expect(instance.view.dom.querySelector('.fm-block-gap')).toBeNull();
});

it('源码已有空行时不叠加语义块间距', () => {
  const text = '- [ ] 标题\n\n  ```\n  hell\n  ```\n\n  > faf\n\n  ```\n  s\n  ```\n\n  $$a=b_i$$\n\n末尾';
  instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} });
  instance.focusAt(text.length);
  expect(instance.view.dom.querySelectorAll('.fm-block-gap')).toHaveLength(0);
});

it('引用容器的空标记行已经提供间隔，不再叠加块间距', () => {
  const text = '- [ ] 标题\n\n  > 前段\n  >\n  > 后段\n\n末尾';
  instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} });
  instance.focusAt(text.length);
  expect(instance.view.dom.querySelectorAll('.fm-block-gap')).toHaveLength(0);
});
