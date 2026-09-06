/** 文件职责：挂载桌面与浏览器共享的应用界面。 */
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

mount(App, { target: document.getElementById('app')! });
