/**
 * 文件职责：定义应用与当前 CodeMirror 实例之间的契约。
 * 定义范围：初始化选项、交互命令与界面状态类型。
 */
import type { ProjectView, ViewMode } from '../contracts';
import type { ClipboardPort } from '../clipboard';
import type { CanvasAsset, CanvasSession } from '../canvas/types';

/**
 * 结构职责：注入文档和应用反馈端口。
 * 字段说明：onChange 仅在正文事务发生后调用；mode 控制投影与编辑能力。
 * 约束条件：回调不得同步替换正在提交的编辑器状态。
 */
export interface EditorOptions {
  /** 手机使用系统选字菜单；触摸滚动不启动桌面列表拖动。 */
  nativeSelection?: boolean;
  text: string;
  mode: ViewMode;
  onChange: (text: string) => void;
  /** 纯折叠/展开状态变化时通知应用保存界面配置，不触发正文保存或修改文本历史。 */
  onUIChange?: () => void;
  onStatus?: (message: string) => void;
  /** 纯文本剪贴板可替换端口；缺省使用当前平台实现，不扩大正文读写权限。 */
  clipboard?: ClipboardPort;
  /** 相对图像或本地路径由文件层按当前清单目录解析；网络 URL 保持原样。 */
  resolveResource?: (url: string) => string;
  /** 应用负责系统浏览器或本地文件打开；预览不直接访问磁盘。 */
  openLink?: (url: string) => void | Promise<void>;
  /** 标题下新增任务入口的初始启用状态；运行时切换走 setHeadingAddEnabled。 */
  headingAddEnabled?: boolean;
  /** 应用按需挂载画布引擎；会话负责原文范围校验，不向引擎暴露整个正文。 */
  openCanvas?: (session: CanvasSession) => void;
  /** 按当前文档目录读取缩略图所需图片；控件负责创建和释放本机 Blob URL。 */
  resolveCanvasImage?: (asset: CanvasAsset) => Promise<Blob>;
}

/**
 * 结构职责：标识拖动会话的内容类型。
 * 字段说明：item 表示列表条目连同子树，canvas 表示整块画布围栏。
 * 约束条件：类型只决定候选落点与提交事务，指针状态机和视觉反馈由同一实现承载。
 */
export type DragKind = 'item' | 'canvas';

/**
 * 接口职责：把预览控件意图交给唯一编辑器命令入口。
 * 调用方：预览装饰和指针拖动插件。
 * 实现要求：位置为当前源文偏移，拖动开始后正文变化必须取消提交。
 */
export interface EditorActions {
  toggleTask: (from: number, group?: boolean) => void;
  toggleFold: (from: number) => void;
  /** 切换父项下完成子任务组的展开状态；不改变 Markdown 或任务归档归属。 */
  toggleCompletedGroup: (parentFrom: number) => void;
  moveItem: (from: number, direction: 'up' | 'down') => void;
  moveTo: (from: number, boundary: number | null) => void;
  /** 提交拖动落点；boundary 使用当前源文偏移，null 表示可见内容末尾，事务由拖动类型决定。 */
  moveDrag: (kind: DragKind, from: number, boundary: number | null) => void;
  /** 外部导航定位：展开折叠目标并居中滚动。 */
  focusAt: (from: number) => void;
  /** 点击已可见的预览控件时只放置光标，不滚动、不改变折叠或渲染窗口。 */
  placeCaret: (from: number) => void;
  /** 在可见源文偏移处插入空任务并移入光标；标题下的新增按钮传入标题块之后的边界。 */
  insertTaskAt: (position: number) => void;
  /** 使用当前源文范围打开画布；不得仅按可复制的画布 id 定位。 */
  openCanvas: (from: number) => void;
}

export type { ProjectView, ViewMode };
