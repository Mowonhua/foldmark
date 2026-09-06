/**
 * 文件职责：比较相同完整语法树上的全量投影与受限文字映射成本。
 * 定义范围：固定 5000 任务、20 正式样本及语义一致性核对；不代表浏览器绘制反馈。
 */
import { it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { cpus, platform, release } from 'node:os';
import { writeFileSync } from 'node:fs';
import { parseDocument, markdownExtensions, type DocumentModel } from '../markdown';
import { tryMapTaskTextEdit } from './incremental-model';

/** 所有分位数由原始正式样本计算，保留默认 GC 和工作站其它任务造成的波动。 */
function summary(samples: number[]) {
  const sorted = [...samples].sort((a,b)=>a-b);
  return { samples,min:sorted[0],median:(sorted[9]+sorted[10])/2,p95:sorted[18],max:sorted[19] };
}
function projection(model: DocumentModel) { const { tree:_tree,...value }=model; return value; }

it('固定大文档映射与全树投影采用相同新树和源文', () => {
  const fragments: string[] = [];
  for (let index=0;index<5000;index++) {
    if (index%50===0) fragments.push(`\n## 项目 0 · 章节 ${index/50+1}\n\n`);
    const slot=index%10;
    const depth=slot===0||slot===9?0:slot===5||slot===8?2:1;
    const indent='  '.repeat(depth); const bodyIndent=`${indent}  `;
    fragments.push(`${indent}- [${index%4===0?'x':' '}] 项目 0 任务 ${index+1} **关键说明**\n${bodyIndent}正文保留上下文、边界条件与连续写作内容。\n`);
    if (index%20===0) fragments.push(`${bodyIndent}行内公式 $x^2 + y^2 = ${index+1}$。\n`);
    if (index%100===0) fragments.push(`\n${bodyIndent}$$\n${bodyIndent}\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n${bodyIndent}$$\n`);
    if (index%25===0) fragments.push(`\n${bodyIndent}\`\`\`ts\n${bodyIndent}const task = ${index+1};\n${bodyIndent}\`\`\`\n`);
  }
  const text=fragments.join('');
  const state=EditorState.create({doc:text,extensions:[markdown({extensions:markdownExtensions})]});
  const model=parseDocument(text,ensureSyntaxTree(state,text.length,5000)!);
  expect(model.tasks).toHaveLength(5000);
  const cases=Array.from({length:20},(_,index)=>{
    const item=model.tasks[index*250];
    const transaction=state.update({changes:{from:item.contentFrom+2,insert:'字'}});
    const nextText=transaction.state.doc.toString();
    const tree=ensureSyntaxTree(transaction.state,nextText.length,5000)!;
    return {transaction,nextText,tree};
  });
  const full: number[]=[]; const mapped: number[]=[];
  for (let iteration=-3;iteration<20;iteration++) {
    const sample=cases[Math.max(0,iteration)];
    let normal!:DocumentModel; let fast:DocumentModel|null=null;
    const normalRun=()=>{const start=performance.now();normal=parseDocument(sample.nextText,sample.tree);const elapsed=performance.now()-start;if(iteration>=0)full.push(elapsed)};
    const fastRun=()=>{const start=performance.now();fast=tryMapTaskTextEdit(model,sample.transaction.changes,sample.nextText,sample.tree);const elapsed=performance.now()-start;if(iteration>=0)mapped.push(elapsed)};
    // 两条路径交替先后执行，避免总让同一路径承担第一轮分配或缓存状态。
    if(iteration%2===0){normalRun();fastRun()}else{fastRun();normalRun()}
    expect(fast).not.toBeNull();
    expect(projection(fast!)).toEqual(projection(normal));
  }
  const report={
    schema:'foldmark.incremental-model-performance.v1',recordedAt:new Date().toISOString(),
    command:'npx vitest run --config src/lib/editor/vitest.perf.config.ts src/lib/editor/incremental-model.perf.ts',
    workload:{taskCount:5000,utf8Bytes:new TextEncoder().encode(text).length,characters:text.length,maxListDepth:Math.max(...model.items.map(item=>item.depth))+1,headings:model.headings.length},
    environment:{node:process.version,os:platform(),osRelease:release(),cpu:cpus()[0]?.model,logicalProcessors:cpus().length},
    boundary:'两路径接收完全相同的已更新 Lezer 完整语法树与文本；只比较模型投影，不计语言解析、DOM、布局或绘制。',
    method:{warmups:3,samples:20,order:'交替先后',validation:'每个样本结束后与独立完整投影逐字段比较；断言和负载准备不计入计时',threshold:'不设置工作站相关的强制耗时阈值'},
    fullTreeProjectionMs:summary(full),restrictedMappingMs:summary(mapped),
    limitations:['只优化单行任务内容中的普通字母数字空格，结构字符、代码、公式及正文继续完整投影','正式 UI 反馈需要真实浏览器重新测量','未隔离工作站其它进程或默认 GC'],
  };
  writeFileSync('docs/performance-incremental-model.json',JSON.stringify(report,null,2)+'\n','utf8');
  console.log(JSON.stringify({workload:report.workload,fullTreeProjection:report.fullTreeProjectionMs,restrictedMapping:report.restrictedMappingMs},null,2));
},30000);
