/**
 * 文件职责：为正文编辑动作提供跨平台纯文本剪贴板端口。
 * 定义范围：纯文本读写契约与桌面、浏览器环境适配。
 */
import { isTauri } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

// ==================== 接口与抽象契约 ====================

/**
 * 接口职责：读取和覆盖系统剪贴板中的纯文本内容。
 * 调用方：正文菜单的复制、剪切和粘贴动作。
 * 实现要求：保持文本原样；平台不支持或拒绝访问时必须拒绝 Promise，不能将失败视为成功。
 */
export interface ClipboardPort {
  /**
   * 函数职责：读取调用时的纯文本剪贴板。
   * 输入说明：无参数；浏览器可能要求安全上下文和用户操作权限。
   * 输出说明：返回读取的原始文本，空字符串是有效内容；访问失败向调用方传播异常。
   * 实现思路：桌面使用原生插件，浏览器使用 navigator.clipboard。
   */
  readText(): Promise<string>;

  /**
   * 函数职责：用给定的纯文本覆盖剪贴板。
   * 输入说明：文本来自编辑器选区或菜单动作；允许空字符串且不转换换行。
   * 输出说明：仅在平台确认写入成功后完成；访问失败向调用方传播异常。
   * 实现思路：按运行环境调用原生插件或 navigator.clipboard，保留平台错误。
   */
  writeText(text: string): Promise<void>;
}

// ==================== 导出与适配器 ====================

export const clipboard: ClipboardPort = {
  async readText() {
    // 桌面始终走原生端口；失败不能回退到 WebView，以免掩盖插件权限或系统剪贴板错误。
    if (isTauri()) return readText();
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
      throw new Error('Clipboard text reading is unavailable.');
    }
    return navigator.clipboard.readText();
  },
  async writeText(text) {
    if (isTauri()) return writeText(text);
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      throw new Error('Clipboard text writing is unavailable.');
    }
    return navigator.clipboard.writeText(text);
  },
};
