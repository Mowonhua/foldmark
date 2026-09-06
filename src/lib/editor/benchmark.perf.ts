/**
 * 文件职责：测量固定混合大文档的编辑器事务成本。
 * 定义范围：5,000 任务初始化、选区与输入的同步边界；不把 jsdom 耗时当作屏幕反馈。
 */
import { it } from 'vitest';
import { EditorController } from './index';

it('固定 5,000 任务同步事务基准', () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const text = Array.from({ length: 5000 }, (_, index) => `${index % 50 === 0 ? `\n## 章节 ${index / 50}\n\n` : ''}- [${index % 4 === 0 ? 'x' : ' '}] 任务 ${index} **关键说明**\n  多段正文和边界条件 ${index}\n${index % 20 === 0 ? '  公式 $x^2+y^2$\n' : ''}`).join('');
  const parent = document.createElement('div'); document.body.append(parent);
  const start = performance.now();
  const editor = new EditorController(parent, { text, mode: 'todo', onChange: () => {} });
  const initialization = performance.now() - start;
  const selection: number[] = []; const input: number[] = [];
  for (let index = 0; index < 25; index++) {
    const from = 90 + index % 3;
    let start = performance.now(); editor.view.dispatch({ selection: { anchor: from } });
    if (index >= 5) selection.push(performance.now() - start);
    start = performance.now(); editor.view.dispatch({ changes: { from, insert: '字' } });
    if (index >= 5) input.push(performance.now() - start);
  }
  const stats = (samples: number[]) => { const sorted = [...samples].sort((a, b) => a - b); return { p50: sorted[Math.floor(samples.length * .5)], p95: sorted[Math.ceil(samples.length * .95) - 1], samples }; };
  console.log(JSON.stringify({ runtime: process.version, characters: text.length, tasks: 5000, formulas: 250, completed: 1250, samples: 20, initialization, selection: stats(selection), input: stats(input) }));
  editor.destroy(); parent.remove();
}, 30000);
