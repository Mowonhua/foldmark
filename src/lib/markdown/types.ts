/**
 * 文件职责：定义基于 Markdown 语法树的任务模型与纯文本事务。
 * 定义范围：列表项坐标、任务状态、视图投影及搜索结果。
 */
import type { Tree } from '@lezer/common';

/**
 * 结构职责：表示源文坐标中的一次替换。
 * 字段说明：from/to 为左闭右开区间，insert 为替换文本。
 * 约束条件：同一操作返回的所有区间互不重叠，统一相对于操作前文档。
 */
export interface TextChange { from: number; to: number; insert: string }
/**
 * 结构职责：表示语法树中完整列表项及其父子关系。
 * 字段说明：from/to 为语法节点范围；moveFrom/moveTo 为物理行范围；children 保存直接子项 from。
 * 约束条件：firstLineTo 不含换行，task 范围包含完整方括号；无任务标记时 task 为 null。
 */
export interface ListItem {
  from: number; to: number; firstLineTo: number;
  markerFrom: number; markerTo: number; contentFrom: number;
  /** 移动包含首行缩进及末尾行分隔；最后一项可至文件结尾。 */
  moveFrom: number; moveTo: number;
  parentFrom: number | null; listFrom: number; listTo: number; depth: number;
  task: { checked: boolean; from: number; to: number } | null;
  children: number[];
}
/**
 * 结构职责：保存一份不可独立编辑的语法投影。
 * 字段说明：text 与 tree 必须对应同一快照，tasks 引用 items 内对象。
 * 约束条件：模型只用于查询与生成事务，不修改编辑器或磁盘。
 */
export interface DocumentModel {
  text: string; tree: Tree; items: ListItem[]; tasks: ListItem[];
  headings: { from: number; to: number; level: number; text: string }[];
}
/**
 * 结构职责：标识可从视图隐藏的连续完整行。
 * 字段说明：parentFrom 用于父项下显示完成摘要；count 为范围内任务数。
 * 约束条件：返回区间已合并且互不重叠。
 */
export interface HiddenRange { from: number; to: number; parentFrom: number | null; count: number }
/**
 * 结构职责：提供可以定位原文的任务搜索结果。
 * 字段说明：heading 为最近章节，archived 包含被已完成祖先隐藏的情况。
 * 约束条件：标题与摘要从原文截取，不改写 Markdown。
 */
export interface TaskSearchResult { item: ListItem; from: number; to: number; title: string; excerpt: string; heading: string; archived: boolean }
