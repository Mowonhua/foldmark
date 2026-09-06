/**
 * 文件职责：定义应用与当前 CodeMirror 实例之间的契约。
 * 定义范围：初始化选项、交互命令与界面状态类型。
 */
import type { ProjectView, ViewMode } from '../contracts';

/**
 * 结构职责：注入文档和应用反馈端口。
 * 字段说明：onChange 仅在正文事务发生后调用；mode 控制投影与编辑能力。
 * 约束条件：回调不得同步替换正在提交的编辑器状态。
 */
export interface EditorOptions {
  text: string;
  mode: ViewMode;
  onChange: (text: string) => void;
  onStatus?: (message: string) => void;
  /** 相对图像或本地路径由文件层按当前清单目录解析；网络 URL 保持原样。 */
  resolveResource?: (url: string) => string;
  /** 应用负责系统浏览器或本地文件打开；预览不直接访问磁盘。 */
  openLink?: (url: string) => void | Promise<void>;
}

/**
 * 接口职责：把预览控件意图交给唯一编辑器命令入口。
 * 调用方：预览装饰和指针拖动插件。
 * 实现要求：位置为当前源文偏移，拖动开始后正文变化必须取消提交。
 */
export interface EditorActions {
  toggleTask: (from: number, group?: boolean) => void;
  toggleFold: (from: number) => void;
  moveItem: (from: number, direction: 'up' | 'down') => void;
  moveTo: (from: number, boundary: number | null) => void;
  focusAt: (from: number) => void;
}

export type { ProjectView, ViewMode };
