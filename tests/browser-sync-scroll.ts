/** 文件职责：用真实 DOM 几何验收同步接收后的阅读位置保持；替换正文后顶部原文行与像素偏移不得跳动，且替换过程中不得出现锚点行离开视口的中间帧。 */
import { EditorController } from '../src/lib/editor';

const task = (index: number): string => `- [ ] 任务 ${String(index).padStart(3, '0')}\n\n  第 ${index} 项说明段落，包含一些普通正文用于验证行高。`;
const base = '# 工作清单\n\n' + Array.from({ length: 120 }, (_, index) => task(index)).join('\n\n') + '\n';

const mobile = new URLSearchParams(location.search).has('mobile');
const editor = new EditorController(document.querySelector<HTMLElement>('#editor')!, { text: base, mode: 'todo', onChange: () => {}, nativeSelection: mobile });
const button = document.querySelector<HTMLButtonElement>('#verify')!;
const output = document.querySelector<HTMLElement>('#result')!;
const status = document.querySelector<HTMLElement>('#status')!;

/** 等待编辑器测量与虚拟化完成；这些帧只用于布局稳定，不作为验收数据。 */
async function settled(): Promise<void> {
  for (let count = 0; count < 16; count++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

/** 从真实行元素反查视口顶部行，不使用生产代码的采集函数作为验收依据。 */
function topVisibleLine(): { text: string; offset: number } {
  const scroll = editor.view.scrollDOM;
  const top = scroll.getBoundingClientRect().top + scroll.clientTop;
  const element = [...editor.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')].find(line => line.textContent?.trim() && line.getBoundingClientRect().bottom > top + 0.5);
  if (!element) throw new Error('视口内没有可测量的真实原文行');
  return { text: element.textContent ?? '', offset: element.getBoundingClientRect().top - top };
}

/** 记录锚点文本，替换正文后再按同一文本找回该行，比较屏幕偏移。 */
function offsetOf(text: string): number | null {
  const scroll = editor.view.scrollDOM;
  const top = scroll.getBoundingClientRect().top + scroll.clientTop;
  const element = [...editor.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')].find(line => line.textContent === text);
  return element ? element.getBoundingClientRect().top - top : null;
}

/** 中间帧与最终布局仅允许像素取整误差，小幅位移也会表现为闪烁或抽搐。 */
const SETTLE_LIMIT = 1;

async function verify(name: string, next: string): Promise<Record<string, unknown>> {
  const scroll = editor.view.scrollDOM;
  scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * 0.5;
  await settled();
  const before = topVisibleLine();
  editor.setSynchronizedText(next);
  // 逐帧采样锚点行的屏幕偏移：接收替换若发生整份重建，锚点行会短暂离开视口再被拉回，
  // 只看最终状态无法发现这种中间抖动。采样只读布局，不写入滚动位置。
  const drift: (number | null)[] = [];
  for (let count = 0; count < 16; count++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const offset = offsetOf(before.text);
    drift.push(offset === null ? null : offset - before.offset);
  }
  const after = offsetOf(before.text);
  const top = topVisibleLine();
  const offsetDifference = after === null ? Number.POSITIVE_INFINITY : after - before.offset;
  const lostFrames = drift.filter(value => value === null).length;
  const peakDrift = drift.reduce<number>((peak, value) => Math.max(peak, value === null ? Number.POSITIVE_INFINITY : Math.abs(value)), 0);
  return {
    name, before, after, offsetDifference, peakDrift, lostFrames, drift, sameTopLine: top.text === before.text,
    pass: after !== null && Math.abs(offsetDifference) <= SETTLE_LIMIT && top.text === before.text && lostFrames === 0 && peakDrift <= SETTLE_LIMIT,
  };
}

button.addEventListener('click', async () => {
  button.disabled = true; status.textContent = '正在测量真实布局…'; output.textContent = '';
  try {
    const scenarios = [];
    // 末尾追加不改变锚点上方布局，替换后必须停在原行原偏移。
    scenarios.push(await verify('末尾追加', editor.text + '\n\n# 追加章节\n\n- [ ] 新任务\n\n  说明。\n'));
    // 锚点上方插入正文，锚点随差异映射，屏幕位置仍须保持。
    scenarios.push(await verify('上方插入', '新增段落\n\n' + editor.text));
    // 锚点上方整段删除，锚点行内容不变时屏幕位置仍须保持。
    scenarios.push(await verify('上方删除', editor.text.slice(editor.text.indexOf('第 5 项说明'))));
    scenarios.push(await verify('上方多处修改', editor.text.replace('任务 010', '修改后的任务 010').replace('任务 020', '修改后的任务 020')));
    // 连续接收不能留下上一轮延迟校正，干扰下一轮阅读位置。
    for (let index = 0; index < 3; index++) scenarios.push(await verify(`连续接收 ${index + 1}`, `第 ${index} 轮新增\n\n` + editor.text));
    editor.toggleSource(); await settled();
    scenarios.push(await verify('源码上方插入', '源码新增\n\n' + editor.text));
    const result = { pass: scenarios.every(scenario => scenario.pass), scenarios };
    output.textContent = JSON.stringify(result, null, 2);
    status.textContent = result.pass ? '通过' : '存在偏差';
  } catch (error) {
    output.textContent = String(error); status.textContent = '执行失败';
  } finally { button.disabled = false; }
});
