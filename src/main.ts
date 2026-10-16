/** 文件职责：挂载桌面与浏览器共享的应用界面，并在首帧样式就绪后显示桌面窗口。 */
import { mount } from 'svelte';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App.svelte';
import './app.css';
import { applyTheme, bootThemeKey, builtInThemes, parseTheme, type ThemeDefinition, type ThemeMode } from './lib/themes';

/**
 * 配置异步恢复前从启动缓存取首帧配色；缓存由 App 在主题生效时回写。
 * 缓存缺失、损坏或未通过主题校验时回退内置默认主题，避免 CSS 维护另一份默认主题。
 */
function bootTheme(): { theme: ThemeDefinition; mode: ThemeMode } {
  try {
    const cached = localStorage.getItem(bootThemeKey);
    if (cached) {
      const value = JSON.parse(cached) as { definition?: unknown; mode?: unknown };
      if (value.mode === 'light' || value.mode === 'dark' || value.mode === 'system')
        return { theme: parseTheme(JSON.stringify(value.definition)), mode: value.mode };
    }
  } catch { /* 缓存不可信时按无缓存处理。 */ }
  return { theme: builtInThemes[0], mode: 'system' };
}

const boot = bootTheme();
applyTheme(document.documentElement, boot.theme, boot.mode, window.matchMedia('(prefers-color-scheme: dark)').matches);
mount(App, { target: document.getElementById('app')! });

// 桌面窗口以 visible:false 创建，避免 webview 首帧前露出透明空窗。
// 隐藏窗口可能暂停 rAF，不能用它等待绘制完成；短延时后直接显示，由系统合成首帧。
if (isTauri()) setTimeout(() => { void getCurrentWindow().show().then(() => getCurrentWindow().setFocus()); }, 50);
