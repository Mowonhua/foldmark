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

<p class="muted">当前版本 {currentVersion} · {currentVersion.includes('-') ? '预览通道' : '稳定通道'}</p>
{#if desktop}
  <div class="update-preferences">
    <label class="check-label"><input type="checkbox" aria-label="启动时检查更新" checked={autoCheck} disabled={status.kind === 'installing'} onchange={event => onPreferences(event.currentTarget.checked, autoDownload)}/>启动时检查更新</label>
    <label class="check-label"><input type="checkbox" aria-label="自动下载更新" checked={autoDownload} disabled={status.kind === 'installing'} onchange={event => onPreferences(autoCheck, event.currentTarget.checked)}/>自动下载更新</label>
  </div>
  <p class="small muted">下载完成后会提醒你。点击安装时先保存全部文档，再关闭应用并更新。</p>
  <div role="status" aria-live="polite">
    {#if status.kind === 'idle'}<p>检查是否有可用的新版本。</p>
    {:else if status.kind === 'checking'}<p>正在检查更新…</p>
    {:else if status.kind === 'current'}<p>当前已是最新版本。</p>
    {:else if status.kind === 'available'}<p>发现新版本 {status.version}</p>
    {:else if status.kind === 'downloading'}<p>正在下载 {status.version}…{progress === undefined ? '' : ` ${progress}%`}</p><progress aria-label="更新下载进度" max="100" value={progress}></progress>
    {:else if status.kind === 'ready'}<p>新版本 {status.version} 已准备好安装。</p>
    {:else if status.kind === 'installing'}<p>正在保存文档并安装更新，请稍候…</p>
    {:else if status.kind === 'error'}<p class="dialog-error">更新未完成：{status.message}</p>{/if}
  </div>
  {#if status.body}<details><summary>更新说明</summary><pre class="release-notes">{status.body}</pre></details>{/if}
  <div class="modal-actions">
    {#if ['idle', 'current', 'checking'].includes(status.kind)}<button class="primary" disabled={busy} onclick={onCheck}>检查更新</button>{/if}
    {#if status.kind === 'available'}<button class="primary" onclick={onDownload}>下载更新</button>{/if}
    {#if status.kind === 'ready'}<button class="primary" onclick={onInstall}>安装并重启</button>{/if}
    {#if status.kind === 'error'}<button class="primary" onclick={onRetry}>重试</button>{/if}
  </div>
{:else}
  <p>检测与自动更新仅在桌面版中可用。</p>
{/if}

<style>
  .update-preferences {display:grid;gap:10px;margin:20px 0}
  .update-preferences label {display:flex;align-items:center;gap:8px;margin:0}
  .update-preferences input {width:auto;accent-color:var(--accent)}
  progress {width:100%;accent-color:var(--accent)}
  .release-notes {white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:200px;overflow:auto}
</style>
