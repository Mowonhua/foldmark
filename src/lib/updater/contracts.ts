/**
 * 文件职责：声明更新生命周期及平台端口的稳定契约。
 * 定义范围：更新状态、下载进度、候选安装包和协调器依赖。
 */

// ==================== 状态与数据 ====================

/**
 * 结构职责：标识更新生命周期中唯一有效的阶段。
 * 字段说明：ready 表示安装包下载和签名校验均已成功；installing 包含安装前保存。
 * 约束条件：下载完成事件本身不能进入 ready，必须等待平台下载方法成功返回。
 */
export type UpdateKind = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

/**
 * 结构职责：指定错误恢复后需要重新执行的操作。
 * 字段说明：安装前保存失败也归入 install，从已下载的包重新尝试。
 * 约束条件：只在 error 状态出现，不允许绕过下载和保存前置条件。
 */
export type UpdateAction = 'check' | 'download' | 'install';

/**
 * 结构职责：向界面提供累计下载字节数。
 * 字段说明：totalBytes 在服务器未提供有效内容长度时缺省。
 * 约束条件：累计字节数只表示传输进度，不代表签名校验成功。
 */
export interface UpdateProgress { downloadedBytes: number; totalBytes?: number }

/**
 * 结构职责：承载单次更新操作的可展示状态快照。
 * 字段说明：版本和发布说明来自当前候选；message 保留可辨识错误；retry 表示安全重试入口。
 * 约束条件：无候选时不包含版本元数据；下载进度仅由正在执行的候选更新。
 */
export interface UpdateStatus {
  kind: UpdateKind;
  version?: string;
  currentVersion?: string;
  body?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  message?: string;
  retry?: UpdateAction;
}

// ==================== 平台与应用契约 ====================

/**
 * 接口职责：持有一次检查返回的更新资源并提供下载、安装和释放能力。
 * 调用方：更新协调器独占资源，界面只能读取其状态快照。
 * 实现要求：下载返回前验证签名；安装只接受已下载包；close 后不得继续调用资源。
 */
export interface UpdateCandidate {
  readonly version: string;
  readonly currentVersion: string;
  readonly body?: string;
  /** 下载和签名校验成功后才 resolve；失败允许在同一候选上重新下载。 */
  download(onProgress: (progress: UpdateProgress) => void): Promise<void>;
  /** 安装已下载的包并按平台要求重启；调用方必须先完成全部保存。 */
  install(): Promise<void>;
  /** 释放原生更新和已下载包资源；由拥有者确保只调用一次。 */
  close(): Promise<void>;
}

/**
 * 接口职责：隔离远端版本检查及平台更新资源的创建。
 * 调用方：更新协调器和桌面适配器测试。
 * 实现要求：没有新版本时返回 null；网络和版本清单错误必须 reject。
 */
export interface UpdatePort { check(): Promise<UpdateCandidate | null> }

/**
 * 结构职责：注入更新策略及应用退出前的保存边界。
 * 字段说明：autoDownload 默认启用；onStatus 接收快照；beforeInstall 由 App 保存会话及配置。
 * 约束条件：beforeInstall 只有所有数据可安全退出时返回 true；失败不得触发原生安装。
 */
export interface UpdateOptions {
  port: UpdatePort;
  autoDownload?: boolean;
  onStatus: (status: UpdateStatus) => void;
  /** 保存期间锁定编辑；只有安装即将导致退出时才维持锁定。 */
  beforeInstall: () => Promise<boolean>;
  /** 保存被拒绝、抛错或安装失败后解除应用编辑锁。 */
  afterInstallFailure?: () => void;
}
