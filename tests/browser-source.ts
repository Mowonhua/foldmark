/** 文件职责：用真实 DOM 几何验收来源视图源码切换，覆盖行高差、分区隐藏和返回阅读位置。 */
import { EditorController } from '../src/lib/editor';

const taskText = (archive: boolean, index: number): string => {
  const label = `${archive ? '归档' : '待办'}任务 ${String(index + 1).padStart(3, '0')}`;
  const content = [`- [${archive ? 'x' : ' '}] ${label} **核对正文** 与 *强调*`, `  ${label} 的说明段落，包含行内代码 \`value_${index}\` 和普通正文。`];
  if (index % 3 === 0) content.push('  ```ts', `  const value_${index} = ${index};`, `  console.log(value_${index});`, '  ```');
  if (index % 5 === 0) content.push('', `  > ${label} 的引用说明`);
  return content.join('\n');
};
const text = '# 工作清单\n\n' + Array.from({ length: 100 }, (_, index) => taskText(false, index)).join('\n\n')
  + '\n\n# 归档\n\n归档说明：保留原始任务与正文。\n\n' + Array.from({ length: 100 }, (_, index) => taskText(true, index)).join('\n\n') + '\n';
const editor = new EditorController(document.querySelector<HTMLElement>('#editor')!, { text, mode: 'todo', onChange: () => {} });
const button = document.querySelector<HTMLButtonElement>('#verify')!;
const output = document.querySelector<HTMLElement>('#result')!;
const status = document.querySelector<HTMLElement>('#status')!;

/** 等待编辑器测量、滚动和虚拟化完成；这些帧只用于布局稳定，不作为性能数据。 */
async function settled(): Promise<void> {
  for (let count = 0; count < 14; count++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

/** 从真实行元素反查原文，不使用生产代码的位置采集函数作为验收依据。 */
function topVisibleLine(): { from: number; line: number; text: string; top: number; bottom: number; offset: number } {
  const top = editor.view.scrollDOM.getBoundingClientRect().top + editor.view.scrollDOM.clientTop;
  const element = [...editor.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')].find(line => line.getBoundingClientRect().bottom > top + 0.5);
  if (!element) throw new Error('视口内没有可测量的真实原文行');
  const position = editor.view.posAtDOM(element, 0);
  const line = editor.state.doc.lineAt(position);
  const rect = element.getBoundingClientRect();
  return { from: line.from, line: line.number, text: line.text, top: rect.top, bottom: rect.bottom, offset: rect.top - top };
}

function lineElement(anchor: number): HTMLElement {
  const found = editor.view.domAtPos(anchor).node;
  const element = (found instanceof Element ? found : found.parentElement)?.closest<HTMLElement>('.cm-line');
  if (!element) throw new Error(`原文 ${anchor} 未渲染为真实行`);
  return element;
}

function measure(anchor: number) {
  const scroll = editor.view.scrollDOM;
  const rect = lineElement(anchor).getBoundingClientRect();
  const viewportTop = scroll.getBoundingClientRect().top + scroll.clientTop;
  return {
    mode: editor.getUIState().mode,
    sourceView: editor.getUIState().sourceView ?? null,
    anchor,
    line: editor.state.doc.lineAt(anchor).number,
    lineText: editor.state.doc.lineAt(anchor).text,
    cursor: editor.state.selection.main.head,
    scrollTop: scroll.scrollTop,
    viewportTop,
    rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
    offset: rect.top - viewportTop,
    topVisible: topVisibleLine(),
  };
}

async function verify(mode: 'todo' | 'archive') {
  editor.setMode(mode, false);
  const label = `${mode === 'todo' ? '待办' : '归档'}任务 055`;
  const task = editor.model.tasks.find(item => editor.text.slice(item.contentFrom, item.firstLineTo).startsWith(label));
  if (!task) throw new Error(`未找到 ${label}`);
  const cursor = task.contentFrom + label.length;
  editor.focusAt(cursor);
  await settled();
  const scroll = editor.view.scrollDOM;
  // 让中段任务行的顶部轻微越出视口，检查负像素偏移也能恢复。
  scroll.scrollTop += lineElement(task.from).getBoundingClientRect().top - scroll.getBoundingClientRect().top + 7;
  await settled();
  const from = measure(task.from);
  editor.toggleSource(false);
  await settled();
  const source = measure(task.from);
  const otherLabel = mode === 'todo' ? '归档任务' : '待办任务';
  const sourceContainsOtherPartition = (editor.view.contentDOM.textContent ?? '').includes(otherLabel);
  const sourceContainsExpectedTask = (editor.view.contentDOM.textContent ?? '').includes(label);
  const scopeMatches = source.sourceView === mode && !sourceContainsOtherPartition && sourceContainsExpectedTask;
  const sourceOffsetDifference = source.offset - from.offset;
  const sourceScrollBeforeMoving = scroll.scrollTop;
  scroll.scrollTop += 1400;
  await settled();
  const scrolledSource = { scrollTop: scroll.scrollTop, cursor: editor.state.selection.main.head, topVisible: topVisibleLine() };
  editor.toggleSource(false);
  await settled();
  const returned = measure(task.from);
  const returnedOffsetDifference = returned.offset - from.offset;
  return {
    mode, label,
    pass: Math.abs(sourceOffsetDifference) < 2 && Math.abs(returnedOffsetDifference) < 2
      && source.topVisible.from === from.topVisible.from && returned.topVisible.from === from.topVisible.from
      && scopeMatches && returned.mode === mode && returned.cursor === from.cursor
      && Math.abs(scrolledSource.scrollTop - sourceScrollBeforeMoving) > 200,
    sourceOffsetDifference, returnedOffsetDifference, scopeMatches, sourceContainsOtherPartition, sourceContainsExpectedTask,
    from, source, scrolledSource, returned,
  };
}

/** 源码中完成上方任务会在返回时实际搬移文本，阅读锚点和光标应跟随剩余任务映射。 */
async function verifyArchiveAboveAnchor() {
  editor.setText(text, true);
  editor.setMode('todo', false);
  const label = '待办任务 055';
  const findTask = (name: string) => {
    const item = editor.model.tasks.find(task => editor.text.slice(task.contentFrom, task.firstLineTo).startsWith(name));
    if (!item) throw new Error(`未找到 ${name}`);
    return item;
  };
  const task = findTask(label);
  editor.focusAt(task.contentFrom + label.length);
  await settled();
  const scroll = editor.view.scrollDOM;
  scroll.scrollTop += lineElement(task.from).getBoundingClientRect().top - scroll.getBoundingClientRect().top + 7;
  await settled();
  const from = measure(task.from);
  editor.toggleSource(false);
  await settled();
  const above = findTask('待办任务 020');
  if (!above.task) throw new Error('上方待办缺少可编辑的复选框');
  editor.view.dispatch({ changes: { from: above.task.from + 1, to: above.task.from + 2, insert: 'x' }, userEvent: 'input.type' });
  await settled();
  const source = measure(task.from);
  const editedTaskStayedInSource = (editor.view.contentDOM.textContent ?? '').includes(label)
    && editor.text.indexOf('待办任务 020') < editor.text.indexOf('# 归档');
  const sourceScrollBeforeMoving = scroll.scrollTop;
  scroll.scrollTop += 1400;
  await settled();
  const scrolledSource = { scrollTop: scroll.scrollTop, cursor: editor.state.selection.main.head, topVisible: topVisibleLine() };
  editor.toggleSource(true);
  await settled();
  const returnedTask = findTask(label);
  const returned = measure(returnedTask.from);
  const expectedCursor = returnedTask.contentFrom + label.length;
  const completedAbove = findTask('待办任务 020');
  const archivedAbove = !!completedAbove.task?.checked && completedAbove.from > editor.text.indexOf('# 归档');
  const returnedOffsetDifference = returned.offset - from.offset;
  const result = {
    name: '源码完成上方任务后返回并整理归档',
    pass: Math.abs(returnedOffsetDifference) < 2 && returned.cursor === expectedCursor && returned.mode === 'todo'
      && returned.topVisible.from === returnedTask.from && editedTaskStayedInSource && archivedAbove
      && returned.anchor < from.anchor && editor.text !== text
      && Math.abs(scrolledSource.scrollTop - sourceScrollBeforeMoving) > 200,
    returnedOffsetDifference, expectedCursor, editedTaskStayedInSource, archivedAbove,
    expectedLayoutChanged: editor.text !== text,
    anchorShift: returned.anchor - from.anchor,
    from, source, scrolledSource, returned,
  };
  editor.setText(text, true);
  editor.setMode('todo', false);
  await settled();
  return result;
}

button.addEventListener('click', async () => {
  button.disabled = true; status.textContent = '正在测量真实布局…'; output.textContent = '';
  try {
    const scenarios = [];
    for (const mode of ['todo', 'archive'] as const) scenarios.push(await verify(mode));
    const archiveAboveAnchor = await verifyArchiveAboveAnchor();
    const pass = scenarios.every(scenario => scenario.pass) && archiveAboveAnchor.pass && editor.text === text;
    output.textContent = JSON.stringify({ pass, dimensions: { width: 800, height: 600 }, documentUnchanged: editor.text === text, scenarios, archiveAboveAnchor }, null, 2);
    status.textContent = pass ? '通过' : '未通过，请查看坐标差异';
  } catch (error) {
    output.textContent = JSON.stringify({ pass: false, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2);
    status.textContent = '验收发生错误';
  } finally { button.disabled = false; }
});
