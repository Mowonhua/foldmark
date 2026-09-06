/**
 * 文件职责：定义每项目独立的编辑会话与搜索结果。
 * 定义范围：不可变 EditorState、保存状态和查询定位信息。
 */
import type { EditorState } from '@codemirror/state';
import type { Project, ProjectView } from '../contracts';
import type { SaveCoordinator, SaveStatus } from './save-coordinator';

/** 结构职责：保留项目的唯一编辑状态；挂载后 state 与 EditorView 当前状态同步。 */
export interface ProjectSession {
  project: Project;
  state: EditorState;
  ui: ProjectView;
  saver: SaveCoordinator;
  status: SaveStatus;
  /** 恢复读取失败独立于正文保存反馈，避免已保存状态掩盖损坏草稿提示。 */
  recoveryWarning?: string;
  stopWatch: () => void;
}
/** 结构职责：表示只读搜索投影；from 仅作为定位锚点，不允许直接修改搜索副本。 */
export interface TaskResult { projectId: string; projectName: string; from: number; title: string; section: string; checked: boolean }
