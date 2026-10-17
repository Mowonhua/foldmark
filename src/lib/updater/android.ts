/**
 * 文件职责：适配 Android 原生 APK 更新会话。
 * 定义范围：原生命令结果、下载监听与系统安装器交接。
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core';
import { translate } from '../i18n';
import type { UpdateCandidate, UpdatePort, UpdateProgress } from './contracts';

/**
 * 接口职责：把原生持有的候选资源接入共用更新协调器。
 * 调用方：Android 应用启动流程。
 * 实现要求：下载完成前必须通过原生签名校验；安装授权不足时允许重试。
 */
export class AndroidUpdatePort implements UpdatePort {
  /**
   * 函数职责：检查稳定版并封装原生更新资源。
   * 输入说明：版本来源及下载地址由原生插件限定。
   * 输出说明：无新版返回 null，错误交给协调器展示。
   * 实现思路：调用原生命令，在单次下载期间订阅进度，安装后交回系统确认。
   */
  async check(): Promise<UpdateCandidate | null> {
    const result = await invoke<{ available: boolean; version?: string; currentVersion: string; body?: string }>('plugin:foldmark-mobile|checkUpdate');
    if (!result.available) return null;
    if (!result.version) throw new Error('更新版本信息缺失');
    return {
      version: result.version, currentVersion: result.currentVersion, body: result.body, keepsAppRunning: true,
      async download(onProgress) {
        const listener = await addPluginListener<UpdateProgress>('foldmark-mobile', 'updateProgress', onProgress);
        try { onProgress(await invoke<UpdateProgress>('plugin:foldmark-mobile|downloadUpdate')); }
        finally { await listener.unregister(); }
      },
      async install() {
        const result = await invoke<{ status: string }>('plugin:foldmark-mobile|installUpdate');
        if (result.status === 'permission-required') throw new Error(translate('请允许安装权限，返回后重试安装。'));
        if (result.status !== 'installer-opened') throw new Error('无法打开系统安装器');
      },
      close: () => invoke<void>('plugin:foldmark-mobile|closeUpdate'),
    };
  }
}
