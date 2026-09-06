/**
 * 文件职责：定义应用与文件层之间的稳定数据契约。
 * 定义范围：项目关联、界面偏好、文件快照和异步文件端口。
 */

/** 结构职责：承载持久化项目关联；路径只指向原文件，移除关联不得删除文件。 */
export interface Project { id: string; name: string; path: string }
/** 结构职责：表示文档投影视图；源码始终保留完整文本。 */
export type ViewMode = 'todo' | 'archive' | 'source';
/** 结构职责：保存可配置的阅读参数；字号以像素表示。 */
export interface Preferences { theme: 'light' | 'dark' | 'system'; fontFamily: string; fontSize: number; contentWidth: number }
/** 结构职责：保存独立于 Markdown 的配置；正文及编辑历史不属于配置。 */
export interface AppConfig { projects: Project[]; activeProjectId: string | null; preferences: Preferences; projectViews: Record<string, ProjectView> }
/** 结构职责：保存可可靠恢复的界面定位；折叠键失配时默认展开。 */
export interface ProjectView { mode: ViewMode; cursor: number; scrollTop: number; folded: string[] }
/** 结构职责：承载读取时的文本与磁盘基线；revision 是不透明的内容指纹。 */
export interface FileSnapshot { path: string; text: string; revision: string }
/** 结构职责：记录未落盘修改和原始基线，用于异常退出恢复与冲突判断。 */
export interface RecoveryDraft { path: string; text: string; baseRevision: string; savedAt: number }
/**
 * 接口职责：隔离平台文件访问与应用编辑策略。
 * 调用方：项目会话与保存协调器。
 * 实现要求：保存前验证基线，原子替换；冲突以 FILE_CONFLICT 错误码报告并保留双方内容。
 */
export interface FilePort {
  read(path: string): Promise<FileSnapshot>;
  write(path: string, text: string, expectedRevision: string): Promise<FileSnapshot>;
  create(path: string, text: string): Promise<FileSnapshot>;
  loadConfig(): Promise<AppConfig | null>;
  saveConfig(config: AppConfig): Promise<void>;
  loadRecovery(path: string): Promise<RecoveryDraft | null>;
  saveRecovery(draft: RecoveryDraft): Promise<void>;
  clearRecovery(path: string): Promise<void>;
  chooseFile(create: boolean): Promise<string | null>;
  watch(path: string, onChange: () => void): Promise<() => void>;
}
