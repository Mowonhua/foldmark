<script lang="ts">
  /**
   * 文件职责：呈现更新进度与用户操作入口。
   * 定义范围：更新状态展示和事件契约；网络、安装与保存由应用协调。
   */
  import type { UpdateStatus } from './updater/contracts';
  /**
   * 结构职责：绑定应用持有的更新状态与持久化偏好。
   * 字段说明：操作回调由更新协调器提供，偏好修改由应用保存。
   * 约束条件：浏览器预览只显示桌面版说明，安装期间禁止重复操作。
   */
  interface Props {
    desktop: boolean; currentVersion: string; status: UpdateStatus;
    autoCheck: boolean; autoDownload: boolean;
    onCheck: () => void; onDownload: () => void; onInstall: () => void; onRetry: () => void;
    onPreferences: (autoCheck: boolean, autoDownload: boolean) => void;
  }
  let { desktop, currentVersion, status, autoCheck, autoDownload, onCheck, onDownload, onInstall, onRetry, onPreferences }: Props = $props();
  const busy = $derived(['checking', 'downloading', 'installing'].includes(status.kind));
  const progress = $derived(status.totalBytes ? Math.min(100, Math.floor((status.downloadedBytes ?? 0) / status.totalBytes * 100)) : undefined);
</script>

<p class="update-version">当前版本 <span>{currentVersion}</span></p>
{#if desktop}
  <div class="update-preferences">
    <label class="check-label update-option">
      启动时检查更新
      <span class="update-control">
        <input type="checkbox" role="switch" aria-label="启动时检查更新" checked={autoCheck} disabled={status.kind === 'installing'} onchange={event => onPreferences(event.currentTarget.checked, autoDownload)}/>
        <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
      </span>
    </label>
    <label class="check-label update-option">
      自动下载更新
      <span class="update-control">
        <input type="checkbox" role="switch" aria-label="自动下载更新" checked={autoDownload} disabled={status.kind === 'installing'} onchange={event => onPreferences(autoCheck, event.currentTarget.checked)}/>
        <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
      </span>
    </label>
  </div>
  <div class="update-status" role="status" aria-live="polite">
    {#if status.kind === 'checking'}<p>正在检查更新…</p>
    {:else if status.kind === 'current'}<p>当前已是最新版本。</p>
    {:else if status.kind === 'available'}<p>发现新版本 {status.version}</p>
    {:else if status.kind === 'downloading'}<p>正在下载 {status.version}…{progress === undefined ? '' : ` ${progress}%`}</p><progress aria-label="更新下载进度" max="100" value={progress}></progress>
    {:else if status.kind === 'ready'}<p>新版本 {status.version} 已准备好安装。</p>
    {:else if status.kind === 'installing'}<p>正在保存文档并安装更新，请稍候…</p>
    {:else if status.kind === 'error'}<p class="dialog-error">更新未完成：{status.message}</p>{/if}
  </div>
  {#if status.body}<details><summary>更新说明</summary><pre class="release-notes">{status.body}</pre></details>{/if}
  <div class="modal-actions update-actions">
    {#if ['idle', 'current', 'checking'].includes(status.kind)}<button class="primary" disabled={busy} onclick={onCheck}>检查更新</button>{/if}
    {#if status.kind === 'available'}<button class="primary" onclick={onDownload}>下载更新</button>{/if}
    {#if status.kind === 'ready'}<button class="primary" onclick={onInstall}>安装并重启</button>{/if}
    {#if status.kind === 'error'}<button class="primary" onclick={onRetry}>重试</button>{/if}
  </div>
{:else}
  <p>检测与自动更新仅在桌面版中可用。</p>
{/if}

<style>
  .update-version {margin:0;color:var(--muted);font-size:12px;line-height:1.6}
  .update-version span {margin-left:6px;font-variant-numeric:tabular-nums}
  .update-preferences {display:grid;margin:24px 0 18px}
  .update-option {display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:46px;margin:0;padding:10px 0;color:var(--ink);font-size:13px;cursor:pointer}
  .update-option + .update-option {border-top:1px solid var(--divider-color,var(--line))}
  .update-option:has(input:disabled) {cursor:default;color:var(--muted)}
  .update-control {position:relative;display:inline-flex;flex-shrink:0}
  /* 原生复选框保留焦点与 Space/整行点击语义；轨道只负责视觉，不另建交互状态。 */
  .update-control input {position:absolute;width:1px;height:1px;margin:0;padding:0;clip-path:inset(50%);overflow:hidden;white-space:nowrap}
  .switch-track {display:block;width:36px;height:22px;position:relative;border:1px solid var(--field-border,var(--line));border-radius:var(--control-radius,12px);background:var(--control-background,var(--surface));box-shadow:var(--field-shadow,none);transition:background .15s,border-color .15s}
  .switch-thumb {position:absolute;left:3px;top:50%;width:14px;height:14px;border-radius:max(0px,calc(var(--control-radius,12px) - 3px));background:var(--muted);transform:translateY(-50%);transition:transform .15s,background .15s}
  input:checked + .switch-track {background:var(--accent-soft)}
  input:checked + .switch-track .switch-thumb {transform:translate(14px,-50%);background:var(--accent)}
  .update-option:hover input:not(:disabled) + .switch-track {border-color:var(--accent)}
  input:focus-visible + .switch-track {outline:2px solid var(--accent);outline-offset:3px}
  input:disabled + .switch-track {border-style:dashed}
  .update-status {color:var(--muted);font-size:12px;line-height:1.65}
  .update-status p {margin:0}
  .update-status:empty {display:none}
  .update-actions {margin-top:20px}
  progress {width:100%;accent-color:var(--accent)}
  .release-notes {white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:200px;overflow:auto}
</style>
