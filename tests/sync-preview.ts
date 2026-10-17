/** 开发服务器专用的界面验收入口，不参与应用生产构建。 */
import { mount } from 'svelte';
import Preview from './SyncPreview.svelte';
import '../src/app.css';
import '../src/lib/editor/editor.css';
import { applyTheme, builtInThemes } from '../src/lib/themes';
const params = new URLSearchParams(location.search);
applyTheme(document.documentElement, builtInThemes.find(theme => theme.id === params.get('theme')) ?? builtInThemes[0], params.get('mode') === 'dark' ? 'dark' : 'light', false);
document.documentElement.classList.toggle('mobile-platform', params.has('mobile'));
mount(Preview, { target: document.getElementById('app')! });
