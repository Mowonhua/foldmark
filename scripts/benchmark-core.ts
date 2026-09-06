/**
 * 文件职责：可复现地测量 Markdown 内核，记录明确样本与参考环境。
 * 定义范围：固定负载生成、独立采样和 JSON 证据；不测量界面或磁盘保存性能。
 */
import { performance } from 'node:perf_hooks';
import { cpus, totalmem, platform, release } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ChangeSet, Text } from '@codemirror/state';
import { parseDocument, getHiddenRanges, searchTasks, taskToggleChanges, moveItemChanges, indentItemChanges, foldKey } from '../src/lib/markdown';

/**
 * 结构职责：承载同一边界的重复耗时证据。
 * 字段说明：全部时间以毫秒计，samples 按执行顺序保存。
 * 约束条件：样本不含预热、负载生成和断言；不等同于用户输入至绘制耗时。
 */
interface Measurement { name: string; boundary: string; samples: number[]; min: number; median: number; p95: number; max: number }
/**
 * 函数职责：生成确定性的多层任务文档。
 * 输入说明：taskCount 为五的正整数倍，project 用于区分原文。
 * 输出说明：精确 taskCount 项，最大列表深度三层，混合正文、代码及公式。
 * 实现思路：重复固定五任务子树，按稳定频率加入昂贵结构。
 */
function fixture(taskCount: number, project: number): string {
  if (taskCount <= 0 || taskCount % 5 !== 0) throw new Error('FIXTURE_TASK_COUNT');
  const parts: string[] = [`# 项目 ${project}\n\n`];
  for (let group = 0; group < taskCount / 5; group++) {
    if (group % 50 === 0) parts.push(`## 章节 ${group / 50}\n\n`);
    const done = group % 4 === 0 ? 'x' : ' ';
    parts.push(`- [${done}] 项目 ${project} 调研方案 ${group}\n\n  保存结构清晰的中文长正文，用于检查任务所属范围、章节定位以及源文稳定性。`);
    parts.push(`\n\n  这里继续记录具体结果与后续步骤，保持多段正文。\n\n`);
    if (group % 4 === 0) parts.push(`  \`\`\`typescript\n  const sample = "- [ ] 代码中的伪任务";\n  \`\`\`\n\n`);
    if (group % 4 === 0) parts.push('  $$\n  \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n  $$\n\n');
    parts.push(`  - [${done}] 分析输入 ${group}，行内公式 $x^2+y^2=z^2$\n    - [${done}] 验证边界 ${group}\n  - [x] 保存证据 ${group}\n  - [${done}] 整理结论 ${group}\n\n`);
  }
  return parts.join('');
}
/**
 * 函数职责：测量同一内核操作的二十次独立执行。
 * 输入说明：回调不得包含数据准备或断言；每项先执行三次预热。
 * 输出说明：记录原始样本及分位数，不设置未经产品测量确认的通过阈值。
 * 实现思路：使用单调高精度时钟包围操作边界。
 */
function measure(name: string, boundary: string, operation: () => unknown): Measurement {
  for (let warmup = 0; warmup < 3; warmup++) operation();
  const samples: number[] = [];
  for (let index = 0; index < 20; index++) {
    const start = performance.now(); operation(); samples.push(performance.now() - start);
  }
  const ordered = [...samples].sort((a,b)=>a-b);
  return { name, boundary, samples, min: ordered[0], median: (ordered[9]+ordered[10])/2, p95: ordered[18], max: ordered[19] };
}

const projects = Array.from({ length: 20 }, (_, index) => fixture(index === 0 ? 5000 : 250, index));
const models = projects.map(text => parseDocument(text));
if (models[0].tasks.length !== 5000 || models.slice(1).some(model => model.tasks.length !== 250)) throw new Error('FIXTURE_PARSE_MISMATCH');
const current = models[0];
const tree = current.tree;
const source = Text.of(current.text.split('\n'));
const target = current.tasks.find(item => !item.task!.checked && item.children.length === 0)!;
const root = current.tasks.find(item => item.parentFrom === null && !item.task!.checked)!;
const indentTarget = current.tasks.find(item => item.parentFrom === root.from && item.children.length === 0)!;
const nodeCounts: Record<string, number> = {};
tree.iterate({ enter(node) { nodeCounts[node.name] = (nodeCounts[node.name] ?? 0) + 1; } });

const measurements = [
  measure('parseCurrent', '从当前全文解析共享 Markdown 语法树并构建完整列表/任务模型', () => parseDocument(current.text)),
  measure('projectSharedTree', '复用已有语法树，遍历节点并构建完整列表/任务模型', () => parseDocument(current.text, tree)),
  measure('parseTwentyProjects', '顺序解析二十份全文并构建任务模型；含当前大文档及十九份小文档', () => projects.map(text => parseDocument(text))),
  measure('todoProjection', '从已建模型生成所有已完成子树隐藏范围', () => getHiddenRanges(current, 'todo')),
  measure('archiveProjection', '从已建模型计算已完成任务及祖先/章节路径可见范围的补集', () => getHiddenRanges(current, 'archive')),
  measure('searchCurrent', '在当前模型中检索待办任务及正文并构建可定位结果', () => searchTasks(current, '验证 边界', false)),
  measure('searchTwentyProjects', '从缓存模型依次检索二十个项目并构建结果，含归档', () => models.flatMap(model => searchTasks(model, '验证 边界', true))),
  measure('toggleApplyReparse', '生成完成事务、通过 CodeMirror ChangeSet 应用至 Text、序列化并重新解析全文', () => {
    const changes = taskToggleChanges(current, target.from);
    return parseDocument(ChangeSet.of(changes, source.length).apply(source).toString());
  }),
  measure('moveApplyReparse', '生成完整列表项移动事务、通过 CodeMirror ChangeSet 应用、序列化并重新解析全文', () => {
    const changes = moveItemChanges(current, root.from, null);
    return parseDocument(ChangeSet.of(changes, source.length).apply(source).toString());
  }),
  measure('indentApplyReparse', '生成完整列表项缩进事务、通过 CodeMirror ChangeSet 应用、序列化并重新解析全文', () => {
    const changes = indentItemChanges(current, indentTarget.from, 1);
    return parseDocument(ChangeSet.of(changes, source.length).apply(source).toString());
  }),
  measure('foldIdentityCached', '为当前文档全部条目读取已建立内容计数缓存的可靠折叠键', () => current.items.map(item => foldKey(current,item))),
];
const versions = Object.fromEntries(['@lezer/markdown','@codemirror/state','vite','vitest'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version]));
const evidence = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  command: 'npx vite-node scripts/benchmark-core.ts',
  gitRevision: execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDirty: execFileSync('git', ['status','--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  environment: { os: platform(), osRelease: release(), cpu: cpus()[0]?.model, logicalProcessors: cpus().length, physicalMemoryBytes: totalmem(), node: process.version, versions, webView2: '未参与此 Node 内核基准' },
  workload: { projects: 20, currentTasks: 5000, backgroundTasksPerProject: 250, totalTasks: models.reduce((sum,model)=>sum+model.tasks.length,0), currentCharacters: current.text.length, currentUtf8Bytes: Buffer.byteLength(current.text), maxListDepth: Math.max(...current.items.map(item=>item.depth))+1, mathBlocks: nodeCounts.MathBlock ?? 0, inlineMath: nodeCounts.InlineMath ?? 0, fencedCodeBlocks: nodeCounts.FencedCode ?? 0, headings: current.headings.length, completedTasks: current.tasks.filter(item=>item.task!.checked).length, newline: 'LF' },
  method: { samples: 20, warmups: 3, clock: 'node:perf_hooks performance.now', p95: 'nearest-rank ceil(0.95 * 20)，即排序后的第十九个样本', preparationExcluded: true, assertionsExcluded: true, gc: '使用 Node 默认 GC，未强制回收；原始样本保留 GC 干扰', concurrency: '单进程顺序执行；未隔离工作站其它进程负载' },
  scope: { measured: '纯 Markdown 内核与 CodeMirror 文本事务；完整模型重建采样单独列出', excluded: ['DOM 布局和绘制','输入事件到屏幕内容可见','点击到完成态可见','Tauri/WebView2 冷启动','项目 UI 切换','磁盘保存','包含 WebView 进程的应用总内存'], status: '诊断基准，不代表已达到产品输入反馈、归档反馈、冷启动或内存验收目标' },
  processMemoryAtEnd: { ...process.memoryUsage(), caveat: '仅此 Node 基准进程的单时点占用，包含工具运行器；不是桌面应用稳定值或峰值，没有据此声明内存预算达标' },
  measurements,
};
mkdirSync('docs', { recursive: true });
writeFileSync('docs/performance-core.json', JSON.stringify(evidence,null,2)+'\n','utf8');
console.log(JSON.stringify({ output:'docs/performance-core.json', workload:evidence.workload, p95:measurements.map(metric=>({name:metric.name,ms:Number(metric.p95.toFixed(3))})) },null,2));
