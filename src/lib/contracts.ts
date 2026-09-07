/**
 * 文件职责：定义应用与文件层之间的稳定数据契约。
 * 定义范围：项目关联、界面偏好、文件快照和异步文件端口。
 */

/** 结构职责：承载持久化项目关联；路径只指向原文件，移除关联不得删除文件。 */
export interface Project { id: string; name: string; path: string }
/** 结构职责：表示文档投影视图；源码仅显示来源视图范围，底层始终保留完整文本。 */
export type ViewMode = 'todo' | 'archive' | 'source';
import type { ThemeDefinition, ThemeMode } from './themes';
/** 结构职责：保存阅读参数；theme 保留旧版明暗模式语义，themeId 缺省时使用纸面主题。 */
export interface Preferences { theme: ThemeMode; themeId?: string; fontFamily: string; fontSize: number; contentWidth: number }
/** 结构职责：保存独立于 Markdown 的配置；正文及编辑历史不属于配置。 */
export interface AppConfig { projects: Project[]; activeProjectId: string | null; preferences: Preferences; projectViews: Record<string, ProjectView>; /** 完整保存已导入主题，不依赖原 JSON 文件路径。 */ customThemes?: ThemeDefinition[] }
/** 结构职责：保存可可靠恢复的界面定位；折叠键失配时默认展开。 */
export interface ProjectView {
  mode: ViewMode; cursor: number; scrollTop: number; folded: string[];
  /** 源码的来源分区；旧配置缺省时视为待办，不能由当前可见任务反推。 */
  sourceView?: 'todo' | 'archive';
  /** 进入源码前的定位快照；文档坐标随源码编辑映射，返回预览后恢复该阅读位置。 */
  sourceReturn?: SourceReturn;
}
/**
 * 结构职责：保留切入源码前的光标与视口定位。
 * 字段说明：cursor 与 anchor 使用完整文档坐标；offset 是锚点相对视口的有符号像素偏移。
 * 约束条件：所有数字必须有限，cursor、anchor、scrollTop 不得为负；缺省快照沿用当前定位。
 */
export interface SourceReturn { cursor: number; scrollTop: number; anchor: number; offset: number }
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
