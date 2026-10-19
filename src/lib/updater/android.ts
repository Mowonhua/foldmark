/**
 * 文件职责：适配 Android 原生 APK 更新会话。
 * 定义范围：原生命令结果、下载监听、传输错误文案与系统安装器交接。
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core';
import { translate } from '../i18n';
import type { UpdateCandidate, UpdatePort, UpdateProgress } from './contracts';

// ==================== 原生调用 ====================

/**
 * 连接被中断时 Android 网络栈抛出的原始英文信息；这些异常对用户没有可操作含义，统一替换为可重试提示。
 * 只覆盖传输失败（OkHttp、Socket、DNS），原生校验失败仍保留原始信息以便定位问题。
 */
const networkFailurePattern = /unexpected end of stream|Read timed out|Connection reset|Connection refused|Software caused connection abort|Unable to resolve host|Failed to connect|Network is unreachable|Broken pipe|Socket closed/i;

/**
 * 函数职责：把原生更新错误转换为界面可直接展示的文案。
 * 输入说明：error 来自 invoke 拒绝，可能是传输失败或原生校验错误。
 * 输出说明：传输失败返回统一的可重试提示，其余错误返回原始信息。
 * 实现思路：按已知网络异常特征识别传输失败，避免把平台英文异常暴露给用户。
 */
function updateFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return networkFailurePattern.test(message) ? translate('网络中断，请检查网络后重试。') : message;
}

/**
 * 函数职责：调用原生更新命令并统一传输错误文案。
 * 输入说明：command 是插件内固定命令名，不接受外部地址或参数。
 * 输出说明：成功返回原生命令结果；失败抛出界面可直接展示的错误。
 * 实现思路：只在 invoke 边界转换错误，业务分支仍由调用方判断。
 */
async function invokeUpdate<T>(command: string): Promise<T> {
  try { return await invoke<T>(`plugin:taskrail-mobile|${command}`); }
  catch (error) { throw new Error(updateFailureMessage(error)); }
}

// ==================== 平台适配 ====================

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
    const result = await invokeUpdate<{ available: boolean; version?: string; currentVersion: string; body?: string }>('checkUpdate');
    if (!result.available) return null;
    if (!result.version) throw new Error('更新版本信息缺失');
    return {
      version: result.version, currentVersion: result.currentVersion, body: result.body, keepsAppRunning: true,
      async download(onProgress) {
        const listener = await addPluginListener<UpdateProgress>('taskrail-mobile', 'updateProgress', onProgress);
        try { onProgress(await invokeUpdate<UpdateProgress>('downloadUpdate')); }
        finally { await listener.unregister(); }
      },
      async install() {
        const result = await invokeUpdate<{ status: string }>('installUpdate');
        if (result.status === 'permission-required') throw new Error(translate('请允许安装权限，返回后重试安装。'));
        if (result.status !== 'installer-opened') throw new Error('无法打开系统安装器');
      },
      close: () => invokeUpdate<void>('closeUpdate'),
    };
  }
}
