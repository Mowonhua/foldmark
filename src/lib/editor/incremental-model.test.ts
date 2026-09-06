/**
 * 文件职责：用独立完整解析校验受限模型映射，证明快路径不改变任务语义。
 * 定义范围：确定性随机差分、Unicode 和嵌套边界、安全回退及真实状态字段集成。
 */
import { describe, expect, it, vi } from 'vitest';
import { EditorState, type ChangeSpec } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtensions, parseDocument, type DocumentModel } from '../markdown';
import { tryMapTaskTextEdit } from './incremental-model';
import { documentField } from './state';
import * as markdownModel from '../markdown';

function editorState(text: string): EditorState {
  return EditorState.create({ doc: text, extensions: [markdown({ extensions: markdownExtensions })] });
}
function projection(model: DocumentModel) {
  const { tree: _tree, ...value } = model; return value;
}
function edit(text: string, changes: ChangeSpec) {
  const state = editorState(text);
  const oldTree = ensureSyntaxTree(state,state.doc.length,1000)!;
  const previous = parseDocument(state.doc.toString(),oldTree);
  const transaction = state.update({ changes });
  const nextText = transaction.state.doc.toString();
  const nextTree = ensureSyntaxTree(transaction.state,nextText.length,1000)!;
  return { previous, transaction, nextText, nextTree, mapped: () => tryMapTaskTextEdit(previous,transaction.changes,nextText,nextTree) };
}

const structured = '# 第一章\n\n- [ ] 父任务Alpha\n\n  多段说明保留位置。\n\n  - [ ] 子任务Beta\n    - [x] 后代Gamma\n\n  ```md\n  - [ ] 代码伪任务\n  ```\n\n  $$\n  - [ ] 公式伪任务\n  $$\n\n- [ ] \n- [ ] 尾任务𠮷\n\n## 第二章\n\n1. [ ] Ordered文字\n2. [ ] 最后任务';

describe('受限普通文字映射与完整解析一致', () => {
  it.each([
    ['首行开头插入', '- [ ] Alpha\n- [ ] Beta', 6, 6, '汉字'],
    ['首行末尾插入', '- [ ] Alpha\n- [ ] Beta', 11, 11, '文字 12'],
    ['空任务输入', '- [ ] \n- [ ] Beta', 6, 6, '空项输入'],
    ['清空任务正文', '- [ ] Alpha\n- [ ] Beta', 6, 11, ''],
    ['仅空格输入', '- [ ] \n- [ ] Beta', 6, 6, '   '],
    ['正文变为前导空格', '- [ ] Alpha', 6, 7, '  '],
    ['文件末尾无换行', '- [ ] Last', 10, 10, '𠮷'],
    ['相邻普通列表', '- [ ] Alpha\n- plain\n- [ ] Beta', 7, 10, '12'],
    ['同物理行中的嵌套任务', '- - [ ] Alpha\n  - [ ] Beta', 8, 9, '新'],
    ['引用里的任务', '> - [ ] Alpha\n> - [ ] Beta', 8, 9, '新'],
  ])('%s', (_name,text,from,to,insert) => {
    const sample = edit(text as string,{ from: from as number,to:to as number,insert:insert as string });
    const before = structuredClone(projection(sample.previous));
    const fast = sample.mapped();
    expect(fast).not.toBeNull();
    expect(projection(fast!)).toEqual(projection(parseDocument(sample.nextText)));
    expect(fast!.tree).toBe(sample.nextTree);
    expect(projection(sample.previous)).toEqual(before);
    expect(fast!.tasks.every(task=>fast!.items.includes(task))).toBe(true);
  });

  it('350 次确定性 Unicode 增删在嵌套、空项、跨章节及有序任务中与全解析逐次一致', () => {
    let state = editorState(structured);
    let model = parseDocument(structured,ensureSyntaxTree(state,state.doc.length,1000)!);
    let seed = 20260906;
    const random = (limit: number): number => { seed = (Math.imul(seed,1664525)+1013904223) >>> 0; return seed % limit; };
    const inserts = ['汉字','x','  ','42','𠮷',''];
    for (let step = 0; step < 350; step++) {
      const item = model.tasks[random(model.tasks.length)];
      const content = model.text.slice(item.contentFrom,item.firstLineTo);
      const points = [0];
      for (const character of content) points.push(points.at(-1)!+character.length);
      const start = random(points.length);
      const end = Math.min(points.length-1,start+random(3));
      let insert = inserts[random(inserts.length)];
      if (start === end && !insert) insert = 'a';
      const transaction = state.update({ changes: { from: item.contentFrom+points[start],to:item.contentFrom+points[end],insert } });
      const nextText = transaction.state.doc.toString();
      const tree = ensureSyntaxTree(transaction.state,nextText.length,1000)!;
      const next = tryMapTaskTextEdit(model,transaction.changes,nextText,tree);
      expect(next,`step ${step}`).not.toBeNull();
      expect(projection(next!),`step ${step}`).toEqual(projection(parseDocument(nextText)));
      model = next!; state = transaction.state;
    }
  });
});

describe('不满足证明条件时一律完整解析', () => {
  it.each(['\n','\t','\u00a0','-','*','_','[',']','`','$','#','|','~','\\','.','😀','\u0301'])('拒绝结构字符或不支持字符 %j', insert => {
    expect(edit('- [ ] Alpha',{ from:8,insert }).mapped()).toBeNull();
  });
  it.each([
    ['列表标记', '- [ ] Alpha',0,0,'字'],
    ['任务标记', '- [ ] Alpha',3,4,'x'],
    ['标记后的必要空白', '- [ ] Alpha',5,6,''],
    ['普通列表', '- Alpha',3,3,'字'],
    ['标题', '# Alpha',3,3,'字'],
    ['任务续行正文', '- [ ] Alpha\n  body',16,16,'字'],
    ['任务正文段落', '- [ ] Alpha\n\n  body',17,17,'字'],
    ['代码块', '```\n- [ ] code\n```',12,12,'字'],
    ['公式块', '$$\n- [ ] math\n$$',11,11,'字'],
    ['任务内代码块', '- [ ] Alpha\n\n  ```\n  code\n  ```',22,22,'字'],
    ['任务内公式块', '- [ ] Alpha\n\n  $$\n  math\n  $$',21,21,'字'],
    ['首行行内代码', '- [ ] before `code` after',15,15,'字'],
    ['首行行内公式', '- [ ] before $math$ after',15,15,'字'],
    ['首行未闭合公式', '- [ ] before $math',15,15,'字'],
    ['列表内Setext标题', '- [ ] Alpha\n  ---',8,8,'字'],
    ['跨首行换行', '- [ ] Alpha\n  body',10,14,'字'],
  ])('拒绝 %s', (_label,text,from,to,insert) => {
    expect(edit(text as string,{ from:from as number,to:to as number,insert:insert as string }).mapped()).toBeNull();
  });
  it('同一事务的多位置替换不走单变更快路径', () => {
    expect(edit('- [ ] Alpha',{ from:7,to:8,insert:'a' }).previous.tasks).toHaveLength(1);
    expect(edit('- [ ] Alpha',[{from:7,to:8,insert:'a'},{from:9,to:10,insert:'b'}]).mapped()).toBeNull();
  });
  it('不使用未覆盖全文的新语法树', () => {
    const sample=edit('- [ ] Alpha',{from:8,insert:'字'});
    expect(tryMapTaskTextEdit(sample.previous,sample.transaction.changes,sample.nextText,parseDocument('').tree)).toBeNull();
  });
});


describe('编辑器状态字段的受限分支', () => {
  it('普通任务文字复用映射，Markdown结构变化仍调用完整投影', () => {
    const parse = vi.spyOn(markdownModel,'parseDocument');
    try {
      let state = EditorState.create({ doc: '- [ ] Alpha\n- [ ] Beta', extensions: [markdown({ extensions:markdownExtensions }),documentField] });
      parse.mockClear();
      state = state.update({ changes: { from:8,insert:'字' } }).state;
      const mapped = state.field(documentField);
      expect(parse).not.toHaveBeenCalled();
      expect(projection(mapped)).toEqual(projection(parseDocument(state.doc.toString())));
      parse.mockClear();
      state = state.update({ changes: { from:8,insert:'*' } }).state;
      const fallback = state.field(documentField);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(projection(fallback)).toEqual(projection(parseDocument(state.doc.toString())));
    } finally { parse.mockRestore(); }
  });
});

// 编辑周围存在行内结构时仍逐次对照全解析；保守拒绝的端点不强行进入快路径。
describe('混合行内语法周边的安全映射', () => {
  it('强调、链接、引用定义、HTML和硬换行周边的普通文字保持完整模型一致', () => {
    const documents = [
      '- [ ] **强调** 与 [链接](https://example.com) 保留\n  正文\n- [ ] 后项',
      '- [ ] [引用][id]\n\n[id]: https://example.com\n\n- [ ] 后项',
      '- [ ] <span>Alpha</span> 保留\n  正文\n- [ ] 后项',
      '- [ ] \\*literal\\*\n- [ ] 后项',
      '- [ ] Alpha  \n  硬换行正文\n- [ ] 后项',
      '- [ ] www.example.com\n- [ ] 后项',
      '- [ ] \tAlpha\n- [ ] 后项',
    ];
    let accepted = 0;
    for (const text of documents) {
      const item = parseDocument(text).tasks[0];
      for (let position = item.contentFrom; position <= item.firstLineTo; position++) {
        const sample = edit(text,{from:position,insert:'字'});
        const mapped = sample.mapped();
        if (!mapped) continue;
        accepted++;
        expect(projection(mapped),`${text} @${position}`).toEqual(projection(parseDocument(sample.nextText)));
      }
    }
    expect(accepted).toBeGreaterThan(100);
  });
});
