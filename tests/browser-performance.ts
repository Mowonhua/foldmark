/**
 * 文件职责：在真实浏览器中采集当前编辑器的可复现交互性能。
 * 定义范围：固定文档场景、可信输入边界、同步事务和辅助 Event Timing 报告。
 */
import type { EditorView } from '@codemirror/view';
import { EditorController } from '../src/lib/editor';
import { parseDocument, type DocumentModel } from '../src/lib/markdown';

/**
 * 结构职责：保存单个用户事件及其对应事务和下一帧观察值。
 * 字段说明：startedAt 为 performance.now 时间轴；null 表示边界尚未观察到。
 * 约束条件：isTrusted=false 或未发生文档变化的事件不能混入真实性能分位数。
 */
interface InteractionSample {
  sequence: number; kind: 'input' | 'checkbox'; eventName: string; isTrusted: boolean;
  startedAt: number; eventTimestamp: number; inputType: string | null; dataLength: number | null;
  nextRafMs: number | null; firstDocumentChangeMs: number | null; dispatchMs: number[];
  sharedDispatch: boolean; documentChanged: boolean; frameObserved: boolean; visibility: DocumentVisibilityState;
}

/** 结构职责：固定场景统计来自实际生成源文与共享语法模型，不依赖界面可见任务数。 */
interface DocumentFixture {
  text: string; taskCount: number; utf8Bytes: number; maxTaskDepth: number;
  inlineFormulaCount: number; blockFormulaCount: number; codeBlockCount: number;
}

/** 结构职责：记录可被浏览器阈值过滤和量化的原生辅助事件，不与精确计时样本混算。 */
interface NativeEventSample {
  name: string; startTime: number; duration: number; processingStart: number; processingEnd: number; interactionId: number;
}

let editor: EditorController | null = null;
let phase: 'idle' | 'input' | 'checkbox' = 'idle';
let scene: Record<string, unknown> | null = null;
let backgroundModels: DocumentModel[] = [];
let samples: InteractionSample[] = [];
let nativeEvents: NativeEventSample[] = [];
let sequence = 0;
let frameGeneration = 0;
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let nativeObserver: PerformanceObserver | null = null;
let nativeSupport = 'not-started';

/**
 * 函数职责：生成固定数量和可复现嵌套形状的 Markdown 场景。
 * 输入说明：project 决定可区分标题；count 为源文任务总数。
 * 输出说明：公式、代码数量和字节数随原文一起返回，原文由实际编辑器解析。
 * 实现思路：按固定周期生成标题、三级任务、正文、行内与块级公式和代码围栏。
 */
function makeFixture(project: number, count: number): DocumentFixture {
  const fragments: string[] = [];
  let inlineFormulaCount = 0; let blockFormulaCount = 0; let codeBlockCount = 0;
  for (let index = 0; index < count; index++) {
    if (index % 50 === 0) fragments.push(`\n## 项目 ${project} · 章节 ${index / 50 + 1}\n\n`);
    const slot = index % 10;
    const depth = slot === 0 || slot === 9 ? 0 : slot === 5 || slot === 8 ? 2 : 1;
    const indent = '  '.repeat(depth);
    const bodyIndent = `${indent}  `;
    fragments.push(`${indent}- [${index % 4 === 0 ? 'x' : ' '}] 项目 ${project} 任务 ${index + 1} **关键说明**\n${bodyIndent}正文保留上下文、边界条件与连续写作内容。\n`);
    if (index % 20 === 0) { fragments.push(`${bodyIndent}行内公式 $x^2 + y^2 = ${index + 1}$。\n`); inlineFormulaCount++; }
    if (index % 100 === 0) { fragments.push(`\n${bodyIndent}$$\n${bodyIndent}\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n${bodyIndent}$$\n`); blockFormulaCount++; }
    if (index % 25 === 0) { fragments.push(`\n${bodyIndent}\`\`\`ts\n${bodyIndent}const task = ${index + 1};\n${bodyIndent}\`\`\`\n`); codeBlockCount++; }
  }
  const text = fragments.join('');
  return { text, taskCount: count, utf8Bytes: new TextEncoder().encode(text).length, maxTaskDepth: 2, inlineFormulaCount, blockFormulaCount, codeBlockCount };
}

/**
 * 函数职责：开始记录一个真实或合成事件，不生成任何输入。
 * 输入说明：时间起点必须位于事件捕获阶段，早于编辑器提交。
 * 输出说明：下一次 rAF 后冻结对应样本，可信和合成结果分开统计。
 * 实现思路：将事件与其后发生的文档 dispatch 对齐，并保留共同事务标记。
 */
function beginSample(event: Event, kind: 'input' | 'checkbox', input?: InputEvent): void {
  if (phase !== kind || !editor || validSamples(kind).length >= 20) return;
  const sample: InteractionSample = {
    sequence: ++sequence, kind, eventName: event.type, isTrusted: event.isTrusted,
    startedAt: performance.now(), eventTimestamp: event.timeStamp, inputType: input?.inputType ?? null, dataLength: input?.data?.length ?? null,
    nextRafMs: null, firstDocumentChangeMs: null, dispatchMs: [], sharedDispatch: false,
    documentChanged: false, frameObserved: false, visibility: document.visibilityState,
  };
  samples.push(sample);
  const generation = frameGeneration;
  requestAnimationFrame(() => {
    if (generation !== frameGeneration) return;
    sample.nextRafMs = performance.now() - sample.startedAt;
    sample.frameObserved = true;
    if (phase === kind && validSamples(kind).length >= 20) phase = 'idle';
    scheduleReport();
  });
}

/**
 * 函数职责：构造只读 JSON 报告，明确每项数字的测量边界。
 * 输入说明：样本来自用户操作；未提交或不可见页面中的输入保留但不计入有效 P95。
 * 输出说明：包含原始值、统计、环境与局限，不自动宣称产品性能目标已经达标。
 * 实现思路：分别汇总真实输入、真实勾选、合成排除项和原生事件。
 */
function report(): Record<string, unknown> {
  const input = validSamples('input').slice(0, 20);
  const checkbox = validSamples('checkbox').slice(0, 20);
  const summarize = (values: InteractionSample[]) => ({
    count: values.length,
    nextRafMs: summary(values.map(sample => sample.nextRafMs!)),
    synchronousDispatchMs: summary(values.map(sample => sample.dispatchMs.reduce((sum, value) => sum + value, 0))),
    eventToDocumentCommitMs: summary(values.map(sample => sample.firstDocumentChangeMs!)),
    rawSamples: values,
  });
  return {
    schema: 'foldmark.browser-interaction-performance.v1', generatedAt: new Date().toISOString(), phase,
    environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, language: navigator.language, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, visibility: document.visibilityState, timeOrigin: performance.timeOrigin, location: location.pathname },
    fixture: scene,
    measurementBoundaries: {
      input: 'Trusted beforeinput capture to next requestAnimationFrame callback; not final pixels, layout completion, or presentation timestamp.',
      checkbox: 'Trusted pointerup capture or keyboard click capture to next requestAnimationFrame callback; completion text must have committed.',
      dispatch: 'Elapsed synchronous execution of the actual EditorView.dispatch public method when its document changes; includes synchronous DOM updates, excludes later layout and paint.',
      aggregation: 'First 20 visible-page trusted events with a document change observed before their next rAF. P95 is nearest-rank ceil(0.95*N). Raw excluded samples are retained.',
      nativeEventTiming: 'Auxiliary only: requested durationThreshold=16ms, duration is quantized to 8ms. Missing entries are not zero and cannot establish a sub-16ms percentile.',
      instrumentation: 'The JSON report textarea is frozen while sampling. Only compact counters update after measured frames; full serialization happens after sampling stops.',
      excludedProductMetrics: ['Tauri cold startup', 'WebView2 runtime installation', 'WebView2 aggregate process memory', 'disk saving', 'final pixel presentation'],
      automation: 'This page never generates keyboard or pointer input. Script-dispatched untrusted events are reported separately and never included in trusted percentiles.',
    },
    trustedInput: summarize(input), trustedCheckbox: summarize(checkbox),
    trustedOverflow: { input: validSamples('input').slice(20), checkbox: validSamples('checkbox').slice(20) },
    syntheticExcluded: samples.filter(sample => !sample.isTrusted),
    trustedExcludedOrPending: samples.filter(sample => sample.isTrusted && (!sample.documentChanged || !sample.frameObserved || sample.visibility !== 'visible')),
    nativeEventTiming: { support: nativeSupport, requestedDurationThresholdMs: 16, durationGranularityMs: 8, entries: nativeEvents },
  };
}

/** 排序副本保留原始样本顺序；空集合明确返回 null，不能伪装成零延迟。 */
function summary(values: number[]): { p50: number | null; p95: number | null; min: number | null; max: number | null } {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? null, p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null, min: sorted[0] ?? null, max: sorted.at(-1) ?? null };
}

function validSamples(kind: 'input' | 'checkbox'): InteractionSample[] {
  return samples.filter(sample => sample.kind === kind && sample.isTrusted && sample.documentChanged && sample.frameObserved && sample.visibility === 'visible');
}

/** 包装只用于观察公开 dispatch；原参数和返回时序原样委派，不合成事务。 */
function observeDispatch(controller: EditorController): void {
  const view = controller.view;
  const original = view.dispatch;
  view.dispatch = ((...arguments_: unknown[]): void => {
    const before = view.state.doc;
    const started = performance.now();
    Reflect.apply(original, view, arguments_);
    const ended = performance.now();
    if (view.state.doc === before) return;
    const waiting = samples.filter(sample => !sample.frameObserved && !sample.documentChanged);
    for (const sample of waiting) {
      sample.dispatchMs.push(ended - started);
      sample.firstDocumentChangeMs = ended - sample.startedAt;
      sample.sharedDispatch = waiting.length > 1;
      sample.documentChanged = true;
    }
  }) as EditorView['dispatch'];
}

function scheduleReport(): void {
  if (reportTimer !== null) return;
  // 采样中不重写大型 JSON 文本框；其布局会污染下一次输入的 DOM 测量。
  // 原始样本保留在内存，停止采样后再一次性序列化，仅更新定宽计数提示。
  reportTimer = setTimeout(() => { reportTimer = null; if (phase === 'idle') renderReport(); else renderCounts(); }, 80);
}

function renderReport(): void {
  const output = report();
  document.querySelector<HTMLTextAreaElement>('#report-json')!.value = JSON.stringify(output, null, 2);
  renderCounts();
}

function renderCounts(): void {
  const input = validSamples('input').slice(0, 20); const checkbox = validSamples('checkbox').slice(0, 20);
  const number = (value: number | null): string => value === null ? '—' : `${value.toFixed(2)} ms`;
  document.querySelector('#sample-summary')!.textContent = `输入：${input.length} / 20 · 下一 rAF P95 ${number(summary(input.map(sample => sample.nextRafMs!)).p95)}\n勾选：${checkbox.length} / 20 · 下一 rAF P95 ${number(summary(checkbox.map(sample => sample.nextRafMs!)).p95)}\n合成事件（排除）：${samples.filter(sample => !sample.isTrusted).length}`;
  document.querySelector('#status')!.textContent = phase === 'input' ? `正在记录真实输入 ${input.length} / 20` : phase === 'checkbox' ? `正在记录真实勾选 ${checkbox.length} / 20` : editor ? '采样已停止，报告保留' : '尚未载入';
}

function startNativeObserver(): void {
  nativeObserver?.disconnect();
  nativeEvents = [];
  if (!PerformanceObserver.supportedEntryTypes?.includes('event')) { nativeSupport = 'unsupported'; return; }
  try {
    nativeObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const event = entry as PerformanceEventTiming & { interactionId?: number };
        if (!event.target || !editor?.view.dom.contains(event.target)) continue;
        nativeEvents.push({ name: event.name, startTime: event.startTime, duration: event.duration, processingStart: event.processingStart, processingEnd: event.processingEnd, interactionId: event.interactionId ?? 0 });
      }
      scheduleReport();
    });
    nativeObserver.observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit & { durationThreshold: number });
    nativeSupport = 'observing-editor-events';
  } catch (error) { nativeSupport = error instanceof Error ? error.message : 'observer-failed'; }
}

async function loadScene(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('#load-scene')!;
  button.disabled = true; document.querySelector('#status')!.textContent = '正在构建固定场景…';
  phase = 'idle'; frameGeneration++; samples = []; sequence = 0;
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  editor?.destroy();
  const host = document.querySelector<HTMLElement>('#editor-host')!; host.replaceChildren();
  const started = performance.now();
  const main = makeFixture(0, 5000);
  const background = Array.from({ length: 19 }, (_, index) => makeFixture(index + 1, 250));
  const indexStarted = performance.now();
  backgroundModels = background.map(fixture => parseDocument(fixture.text));
  const indexingMs = performance.now() - indexStarted;
  const editorStarted = performance.now();
  editor = new EditorController(host, { text: main.text, mode: 'todo', onChange: () => {}, onStatus: message => { document.querySelector('#status')!.textContent = message; } });
  const editorConstructionMs = performance.now() - editorStarted;
  observeDispatch(editor);
  startNativeObserver();
  editor.view.contentDOM.addEventListener('beforeinput', event => { if (!(event as InputEvent).isComposing) beginSample(event, 'input', event as InputEvent); }, true);
  editor.view.dom.addEventListener('click', event => {
    const marker = (event.target as Element).closest('[role=checkbox]');
    if (marker && event.detail === 0 && marker.getAttribute('aria-checked') === 'false') beginSample(event, 'checkbox');
  }, true);
  const { text: _mainText, ...mainInfo } = main;
  scene = {
    generator: 'deterministic-project-task-cycle-v1', projectCount: 20, mountedEditorViews: document.querySelectorAll('.cm-editor').length,
    main: { ...mainInfo, characters: main.text.length, actualParsedTasks: editor.model.tasks.length, actualMaxDepth: Math.max(...editor.model.tasks.map(item => item.depth)) },
    background: { projectCount: backgroundModels.length, tasksPerProject: 250, totalTasks: backgroundModels.reduce((sum, model) => sum + model.tasks.length, 0), totalCharacters: background.reduce((sum, fixture) => sum + fixture.text.length, 0), totalUtf8Bytes: background.reduce((sum, fixture) => sum + fixture.utf8Bytes, 0), retainedAs: 'Read-only shared syntax models; no background EditorView' },
    scenarioLoad: { indexingMs, editorConstructionMs, totalToReadyMs: null },
  };
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  (scene.scenarioLoad as Record<string, unknown>).totalToReadyMs = performance.now() - started;
  document.querySelector('#scene-summary')!.textContent = `当前：${editor.model.tasks.length} 条任务 · ${main.text.length.toLocaleString()} 字符 · ${main.utf8Bytes.toLocaleString()} UTF-8 字节\n层级：3 级（depth 0–2）· 行内公式 ${main.inlineFormulaCount} · 块公式 ${main.blockFormulaCount} · 代码块 ${main.codeBlockCount}\n后台：19 项目 × 250 任务，仅索引；编辑器实例：1`;
  for (const id of ['start-input', 'jump-end', 'sample-checkbox', 'stop-sampling']) document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = false;
  button.disabled = false;
  const first = editor.model.tasks.find(item => !item.task?.checked && item.children.length === 0);
  if (first) editor.focusAt(first.firstLineTo);
  phase = 'input'; renderReport();
}

window.addEventListener('pointerup', event => {
  if (!editor || !(event.target instanceof Element) || !editor.view.dom.contains(event.target)) return;
  const marker = event.target.closest('[role=checkbox]');
  if (marker?.getAttribute('aria-checked') === 'false') beginSample(event, 'checkbox');
}, true);

document.querySelector('#load-scene')!.addEventListener('click', () => { void loadScene().catch(error => { document.querySelector('#status')!.textContent = error instanceof Error ? error.message : '载入失败'; document.querySelector<HTMLButtonElement>('#load-scene')!.disabled = false; }); });
document.querySelector('#start-input')!.addEventListener('click', () => {
  samples = samples.filter(sample => sample.kind !== 'input'); phase = 'input'; renderReport(); editor?.view.focus();
});
document.querySelector('#jump-end')!.addEventListener('click', () => {
  if (!editor) return;
  const last = [...editor.model.tasks].reverse().find(item => !item.task?.checked && item.children.length === 0);
  if (last) editor.focusAt(last.firstLineTo);
});
document.querySelector('#sample-checkbox')!.addEventListener('click', () => {
  samples = samples.filter(sample => sample.kind !== 'checkbox'); phase = 'checkbox';
  if (editor) { const first = editor.model.tasks.find(item => !item.task?.checked && item.children.length === 0); if (first) editor.focusAt(first.contentFrom); }
  renderReport();
});
document.querySelector('#stop-sampling')!.addEventListener('click', () => { phase = 'idle'; renderReport(); });
document.querySelector('#copy-report')!.addEventListener('click', () => {
  renderReport();
  void navigator.clipboard.writeText(JSON.stringify(report(), null, 2)).then(() => { document.querySelector('#status')!.textContent = 'JSON 已复制'; }).catch(() => { const area = document.querySelector<HTMLTextAreaElement>('#report-json')!; area.focus(); area.select(); document.querySelector('#status')!.textContent = '报告已选中，请按 Ctrl + C'; });
});
document.querySelector('#export-report')!.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `foldmark-browser-performance-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => { nativeObserver?.disconnect(); editor?.destroy(); });
renderReport();
