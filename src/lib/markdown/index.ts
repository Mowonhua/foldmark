/**
 * 文件职责：公开 Markdown 任务内核的纯函数边界。
 * 定义范围：共享语法、模型、文本事务与只读投影。
 */
export type * from './types';
export { parseDocument } from './parse';
export { taskToggleChanges, moveItemChanges, moveItemPosition, indentItemChanges } from './transactions';
export { getHiddenRanges, searchTasks, foldKey, taskIsArchived } from './projection';
export { markdownExtensions, mathExtension } from './syntax';
export { archiveSections, normalizeArchiveChanges } from './archive';
export type { ArchiveSection } from './archive';
