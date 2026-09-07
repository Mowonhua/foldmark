/** 文件职责：挂载桌面与浏览器共享的应用界面。 */
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { applyTheme, builtInThemes } from './lib/themes';

// 配置异步恢复前也从主题包取得首帧配色，避免 CSS 维护另一份默认主题。
applyTheme(document.documentElement, builtInThemes[0], 'system', window.matchMedia('(prefers-color-scheme: dark)').matches);
mount(App, { target: document.getElementById('app')! });
