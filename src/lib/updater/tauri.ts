/**
 * 文件职责：适配桌面原生更新会话。
 * 定义范围：候选检查、累计进度通道、安装交接与候选释放。
 */
import type { UpdateCandidate, UpdatePort } from './contracts';
import { Channel, invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';

// ==================== 原生调用 ====================

/**
 * 结构职责：描述桌面更新检查返回的候选元数据。
 * 约束条件：版本、更新源和签名公钥由原生配置决定，前端不能改写。
 */
interface NativeUpdateInfo {
  version: string;
  currentVersion: string;
  body?: string;
}

/** 原生下载命令已按 200 毫秒节流并给出累计字节，通道只负责转发。 */
interface NativeUpdateProgress { downloadedBytes: number; totalBytes?: number }

// ==================== 桌面适配 ====================

/**
 * 接口职责：从原生桌面更新会话创建平台更新候选。
 * 调用方：仅桌面 App 创建；浏览器预览不调用原生命令。
 * 实现要求：下载进度来自原生累计值；安装前重新校验缓存；Windows 安装器管理退出。
 */
export class TauriUpdatePort implements UpdatePort {
  /**
   * 函数职责：检查新版本并封装原生候选。
   * 输入说明：更新端点、检查超时和签名公钥由原生配置负责。
   * 输出说明：没有更高版本时返回 null；其余平台错误原样传给协调器。
   * 实现思路：调用原生命令，单次下载期间通过 Channel 接收进度。
   */
  async check(): Promise<UpdateCandidate | null> {
    const update = await invoke<NativeUpdateInfo | null>('desktop_update_check');
    if (!update) return null;
    // 原生安装成功会交接给系统安装器；重启失败时只能重试重启，不能再次消费该缓存。
    let installed = false;
    return {
      version: update.version, currentVersion: update.currentVersion, body: update.body,
      async download(onProgress) {
        const progress = new Channel<NativeUpdateProgress>();
        progress.onmessage = onProgress;
        await invoke('desktop_update_download', { onEvent: progress });
      },
      async install() {
        if (!installed) { await invoke('desktop_update_install'); installed = true; }
        // Windows 安装器自行退出并重新启动应用，避免额外唤起尚未替换的旧进程。
        if (!navigator.userAgent.includes('Windows')) await relaunch();
      },
      close: () => invoke('desktop_update_close'),
    };
  }
}
