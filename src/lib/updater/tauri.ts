/**
 * 文件职责：适配 Tauri 更新和进程插件。
 * 定义范围：平台检查超时、下载进度转换及安装后的平台重启行为。
 */
import type { UpdateCandidate, UpdatePort } from './contracts';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

// ==================== 桌面适配 ====================

/**
 * 接口职责：从 Tauri 配置的签名更新源创建平台更新候选。
 * 调用方：仅桌面 App 创建；浏览器预览不调用原生插件。
 * 实现要求：检查超时 15 秒；下载验证签名；Windows 安装器管理退出，其他平台主动重启。
 */
export class TauriUpdatePort implements UpdatePort {
  /**
   * 函数职责：检查配置端点并将插件资源封装为应用端口。
   * 输入说明：端点、公钥和安装模式由 Tauri 配置负责。
   * 输出说明：没有更高版本时返回 null；其余平台错误原样传给协调器。
   * 实现思路：调用插件检查，转换累计进度并封装平台安装和资源关闭。
   */
  async check(): Promise<UpdateCandidate | null> {
    const update = await check({ timeout: 15_000 });
    if (!update) return null;
    // 插件安装成功会释放下载字节；重启失败时只能重试重启，不能再次消费该资源。
    let installed = false;
    return {
      version: update.version, currentVersion: update.currentVersion, body: update.body,
      async download(onProgress) {
        let downloadedBytes = 0;
        let totalBytes: number | undefined;
        await update.download(event => {
          if (event.event === 'Started') {
            downloadedBytes = 0;
            const length = event.data.contentLength;
            totalBytes = length && length > 0 ? length : undefined;
          }
          if (event.event === 'Progress') downloadedBytes += event.data.chunkLength;
          // Finished 仅表示传输结束；签名校验仍可能失败，由 download Promise 决定最终结果。
          if (event.event !== 'Finished') onProgress({ downloadedBytes, totalBytes });
        }, { timeout: 120_000 });
      },
      async install() {
        if (!installed) { await update.install(); installed = true; }
        // Windows 安装器自行退出并重新启动应用，避免额外唤起尚未替换的旧进程。
        if (!navigator.userAgent.includes('Windows')) await relaunch();
      },
      close: () => update.close(),
    };
  }
}
