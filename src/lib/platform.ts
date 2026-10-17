/** 平台判断集中在这里；原生运行环境与桌面窗口能力是两个独立条件。 */
import { isTauri } from '@tauri-apps/api/core';
export function platformCapabilities(native = isTauri(), userAgent = navigator.userAgent) {
  const android = native && /Android/i.test(userAgent);
  return { native, android, desktop: native && !android };
}
