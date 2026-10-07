/**
 * 文件职责：定义应用与文件层之间的稳定数据契约。
 * 定义范围：项目关联、界面偏好、文件快照和异步文件端口。
 */

/** 结构职责：承载持久化项目关联；路径只指向原文件，移除关联不得删除文件。 */
export interface Project {
  id: string; name: string; path: string;
  /** 缺省为未归档；归档保留关联及阅读状态，但不参与导航、聚合和搜索。 */
  archived?: boolean;
}
/** 结构职责：表示文档投影视图；源码仅显示来源视图范围，底层始终保留完整文本。 */
export type ViewMode = 'todo' | 'archive' | 'source';
import type { ThemeDefinition, ThemeMode } from './themes';
import type { LocalePreference } from './i18n';
/** 结构职责：保存阅读参数；theme 保留旧版明暗模式语义，themeId 缺省时使用纸面主题。 */
export interface Preferences {
  /** 界面语言；旧配置缺省为简体中文，system 跟随操作系统语言。 */
  locale?: LocalePreference;
  theme: ThemeMode; themeId?: string; fontFamily: string; fontSize: number; contentWidth: number;
  /** 缺省为 true；仅桌面版启动后检查，关闭后仍允许手动检查。 */
  autoCheckUpdates?: boolean;
  /** 缺省为 true；下载完成后仍需用户启动安装，以便先保存全部文档。 */
  autoDownloadUpdates?: boolean;
  /** 缺省为 false，沿用系统材质行为；true 时请求 Acrylic 在窗口失焦后继续透明。仅原生材质支持时生效。 */
  keepTransparentOnBlur?: boolean;
  /** 缺省为 'nav'；侧栏显示项目导航还是当前文档的大纲目录。 */
  sidebarView?: 'nav' | 'outline';
  /** 缺省为 true；导航模式下侧栏的展开意愿。大纲模式从收起状态临时展开时不改写此值。 */
  sidebarOpen?: boolean;
  /** 缺省为 false；待办视图悬停各级标题时显示“新增任务”入口。 */
  headingAdd?: boolean;
}
/** 结构职责：托管灵感簿的文件关联与阅读状态；文件由应用创建，可重新定位，不进入项目列表。 */
export interface InspirationDoc {
  path: string;
  /** 缺省视为未打开过；形状与项目阅读状态一致，独立保存避免与项目键空间混用。 */
  view?: ProjectView;
  /** 缺省为 false；true 表示上次停留在灵感簿，启动时直接恢复。 */
  active?: boolean;
}
/** 结构职责：保存独立于 Markdown 的配置；正文及编辑历史不属于配置。 */
export interface AppConfig { projects: Project[]; activeProjectId: string | null; preferences: Preferences; projectViews: Record<string, ProjectView>; /** 完整保存已导入主题，不依赖原 JSON 文件路径。 */ customThemes?: ThemeDefinition[]; /** 灵感簿；缺省表示从未打开，首次进入时在托管位置创建。 */ inspiration?: InspirationDoc }
/** 结构职责：保存可可靠恢复的界面定位；折叠键失配时默认展开。 */
export interface ProjectView {
  mode: ViewMode; cursor: number; scrollTop: number; folded: string[];
  /** 已展开的完成子任务组，以父项可靠内容键保存；缺省及身份失配均收起。 */
  expandedCompletedGroups?: string[];
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
