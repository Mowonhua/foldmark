<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { errorMessage } from './session/save-coordinator';

  /**
   * 文件职责：为应用顶部工具栏提供原生窗口控制按钮。
   * 定义范围：窗口状态订阅、最小化、最大化切换和关闭请求；不承担保存决策。
   */
  /**
   * 结构职责：将原生窗口操作失败交给应用的统一提示入口。
   * 字段说明：onerror 接收可直接展示的中文错误消息。
   * 约束条件：仅在 Tauri 桌面环境挂载组件。
   */
  interface Props { onerror: (message: string) => void }
  let { onerror }: Props = $props();
  const window = getCurrentWindow();
  let maximized = $state(false);
  let focused = $state(true);

  /** 关闭只发送请求，让应用现有的 onCloseRequested 完成保存并决定是否销毁窗口。 */
  async function operate(action: 'minimize' | 'toggleMaximize' | 'close'): Promise<void> {
    try { await window[action](); }
    catch (error) { onerror(`窗口操作失败：${errorMessage(error)}`); }
  }

  onMount(() => {
    let disposed = false;
    const listeners: (() => void)[] = [];
    let revision = 0;
    const refreshMaximized = async () => {
      const current = ++revision;
      try {
        const value = await window.isMaximized();
        if (!disposed && current === revision) maximized = value;
      } catch (error) { if (!disposed) onerror(`读取窗口状态失败：${errorMessage(error)}`); }
    };
    // 监听器注册跨越异步边界；若组件已卸载，立即释放迟到的订阅。
    const retain = (unlisten: () => void) => { if (disposed) unlisten(); else listeners.push(unlisten); };
    void (async () => {
      try {
        retain(await window.onResized(() => { void refreshMaximized(); }));
        retain(await window.onFocusChanged(event => { if (!disposed) focused = event.payload; }));
        await refreshMaximized();
        const value = await window.isFocused();
        if (!disposed) focused = value;
      } catch (error) { if (!disposed) onerror(`监听窗口状态失败：${errorMessage(error)}`); }
    })();
    return () => { disposed = true; for (const unlisten of listeners) unlisten(); };
  });
</script>

  <div class="window-controls" class:inactive={!focused} role="group" aria-label="窗口控制">
    <button aria-label="最小化" title="最小化" onclick={() => operate('minimize')}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10"/></svg></button>
    <button aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'} onclick={() => operate('toggleMaximize')}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">{#if maximized}<path d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7z"/>{:else}<path d="M1.5 1.5h9v9h-9z"/>{/if}</svg></button>
    <button class="window-close" aria-label="关闭窗口" title="关闭窗口" onclick={() => operate('close')}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9"/></svg></button>
  </div>

<style>
  .window-controls{display:flex;flex-shrink:0;align-self:stretch;user-select:none}
  .window-controls button{display:grid;place-items:center;width:40px;height:100%;padding:0;border-radius:0;color:var(--muted)}
  .window-controls button:focus-visible{outline-offset:-3px}
  .window-controls svg{fill:none;stroke:currentColor;stroke-width:1}
  .window-controls .window-close:hover{background:var(--danger);color:var(--surface)}
  .window-controls:not(.inactive) button:hover{color:var(--ink)}
  .window-controls:not(.inactive) .window-close:hover{color:var(--surface)}
</style>
