<script lang="ts">
  /**
   * 文件职责：呈现更新进度与用户操作入口。
   * 定义范围：更新状态展示、事件契约与更新说明渲染；网络、安装与保存由应用协调。
   */
  import { t } from './i18n';
  import type { Action } from 'svelte/action';
  import type { UpdateStatus } from './updater/contracts';
  import { renderReleaseNotes } from './updater/release-notes';
  /**
   * 结构职责：绑定应用持有的更新状态与持久化偏好。
   * 字段说明：操作回调由更新协调器提供，偏好修改由应用保存；onOpenLink 走应用统一外链通道。
   * 约束条件：浏览器预览只显示桌面版说明，安装期间禁止重复操作。
   */
  interface Props {
    desktop: boolean; currentVersion: string; status: UpdateStatus;
    autoCheck: boolean; autoDownload: boolean;
    onCheck: () => void; onDownload: () => void; onInstall: () => void; onRetry: () => void;
    onPreferences: (autoCheck: boolean, autoDownload: boolean) => void;
    onOpenLink: (url: string) => void;
  }
  let { desktop, currentVersion, status, autoCheck, autoDownload, onCheck, onDownload, onInstall, onRetry, onPreferences, onOpenLink }: Props = $props();
  const busy = $derived(['checking', 'downloading', 'installing'].includes(status.kind));
  const progress = $derived(status.totalBytes ? Math.min(100, Math.floor((status.downloadedBytes ?? 0) / status.totalBytes * 100)) : undefined);
  /**
   * 挂载时渲染一次，候选更新变化时整体替换内容；渲染产物是安全 DOM，不经过 innerHTML。
   * 点击代理到应用的外链通道：说明文本来自远端，href 已在渲染时做过协议白名单。
   */
  const renderMarkdown: Action<HTMLDivElement, string> = (node, body) => {
    const render = (source: string) => node.replaceChildren(renderReleaseNotes(source));
    const click = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest('a[href]');
      if (!link) return;
      event.preventDefault();
      onOpenLink(link.getAttribute('href')!);
    };
    node.addEventListener('click', click);
    render(body);
    return { update: render, destroy: () => node.removeEventListener('click', click) };
  };
</script>

<p class="update-version">{$t('当前版本')} <span>{currentVersion}</span></p>
{#if desktop}
  <div class="update-preferences">
    <label class="check-label update-option">
      {$t('启动时检查更新')}
      <span class="update-control">
        <input type="checkbox" role="switch" aria-label={$t('启动时检查更新')} checked={autoCheck} disabled={status.kind === 'installing'} onchange={event => onPreferences(event.currentTarget.checked, autoDownload)}/>
        <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
      </span>
    </label>
    <label class="check-label update-option">
      {$t('自动下载更新')}
      <span class="update-control">
        <input type="checkbox" role="switch" aria-label={$t('自动下载更新')} checked={autoDownload} disabled={status.kind === 'installing'} onchange={event => onPreferences(autoCheck, event.currentTarget.checked)}/>
        <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
      </span>
    </label>
  </div>
  <div class="update-status" role="status" aria-live="polite">
    {#if status.kind === 'checking'}<p>{$t('正在检查更新…')}</p>
    {:else if status.kind === 'current'}<p>{$t('当前已是最新版本。')}</p>
    {:else if status.kind === 'available'}<p>{$t('发现新版本 {version}', { version: status.version ?? '' })}</p>
    {:else if status.kind === 'downloading'}<p>{$t('正在下载 {version}…', { version: status.version ?? '' })}{progress === undefined ? '' : ` ${progress}%`}</p><progress aria-label={$t('更新下载进度')} max="100" value={progress}></progress>
    {:else if status.kind === 'ready'}<p>{$t('新版本 {version} 已准备好安装。', { version: status.version ?? '' })}</p>
    {:else if status.kind === 'installing'}<p>{$t('正在保存文档并安装更新，请稍候…')}</p>
    {:else if status.kind === 'error'}<p class="dialog-error">{$t('更新未完成：{message}', { message: status.message ?? '' })}</p>{/if}
  </div>
  {#if status.body}
    <details class="release-notes">
      <summary class="release-notes-summary"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>{$t('更新说明')}</summary>
      <div class="release-notes-body" use:renderMarkdown={status.body}></div>
    </details>
  {/if}
  <div class="modal-actions update-actions">
    {#if ['idle', 'current', 'checking'].includes(status.kind)}<button class="primary" disabled={busy} onclick={onCheck}>{$t('检查更新')}</button>{/if}
    {#if status.kind === 'available'}<button class="primary" onclick={onDownload}>{$t('下载更新')}</button>{/if}
    {#if status.kind === 'ready'}<button class="primary" onclick={onInstall}>{$t('安装并重启')}</button>{/if}
    {#if status.kind === 'error'}<button class="primary" onclick={onRetry}>{$t('重试')}</button>{/if}
  </div>
{:else}
  <p>{$t('检测与自动更新仅在桌面版中可用。')}</p>
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
  /* 折叠行沿用设置面板的摘要模式：箭头随展开旋转，悬停与展开态转强调色。 */
  .release-notes {margin-top:18px;border-top:1px solid var(--divider-color,var(--line))}
  .release-notes-summary {display:flex;align-items:center;gap:8px;min-height:40px;cursor:pointer;list-style:none;font-size:12px;color:var(--muted);user-select:none;transition:color .15s}
  .release-notes-summary::-webkit-details-marker {display:none}
  .release-notes-summary:hover,.release-notes[open] .release-notes-summary {color:var(--accent)}
  .release-notes-summary:focus-visible {outline:2px solid var(--accent);outline-offset:3px;border-radius:var(--control-radius,5px)}
  .release-notes-summary>svg {flex-shrink:0;transition:transform .15s}
  .release-notes[open] .release-notes-summary>svg {transform:rotate(90deg)}
  /* 说明区按输入框容器呈现，限高滚动，排版消费通用语义变量。 */
  .release-notes-body {margin:0 0 16px;padding:12px 14px;border:1px solid var(--field-border,var(--line));border-radius:var(--field-radius,8px);background:var(--field-background,var(--surface));box-shadow:var(--field-shadow,none);max-height:260px;overflow:auto;overscroll-behavior:contain;color:var(--muted);font-size:12px;line-height:1.7}
  .release-notes-body :global(:is(h1,h2,h3,h4,h5,h6)) {margin:14px 0 6px;font-size:12px;font-weight:600;color:var(--ink);line-height:1.5}
  .release-notes-body :global(h1) {font-size:13px}
  .release-notes-body :global(:is(h1,h2,h3,h4,h5,h6):first-child) {margin-top:0}
  .release-notes-body :global(p) {margin:0 0 8px}
  .release-notes-body :global(:is(ul,ol)) {margin:0 0 8px;padding-left:18px}
  .release-notes-body :global(li) {margin:2px 0}
  .release-notes-body :global(a) {color:var(--accent);text-decoration:none}
  .release-notes-body :global(a:hover) {text-decoration:underline;text-underline-offset:3px}
  .release-notes-body :global(:is(strong,em)) {color:var(--ink)}
  .release-notes-body :global(code) {font-family:ui-monospace,Consolas,monospace;font-size:11px;background:var(--surface-alt);border-radius:4px;padding:1px 4px}
  .release-notes-body :global(pre) {margin:0 0 8px;padding:10px 12px;overflow:auto;background:var(--surface-alt);border-radius:var(--control-radius,6px)}
  .release-notes-body :global(pre code) {padding:0;background:none}
  .release-notes-body :global(blockquote) {margin:0 0 8px;padding-left:10px;border-left:2px solid var(--line)}
  .release-notes-body :global(hr) {border:0;border-top:1px solid var(--line);margin:12px 0}
  .release-notes-body :global(img) {display:block;max-width:100%;margin:8px 0;border-radius:5px}
  .release-notes-body :global(input[type=checkbox]) {margin:0 6px 0 0;accent-color:var(--accent);vertical-align:-1px}
  .release-notes-body :global(table) {border-collapse:collapse;margin:0 0 8px}
  .release-notes-body :global(:is(th,td)) {border:1px solid var(--line);padding:4px 8px}
  .release-notes-body :global(th) {font-weight:600;color:var(--ink)}
  .release-notes-body :global(:is(p,ul,ol,blockquote,pre,table,hr,h1,h2,h3,h4,h5,h6):last-child) {margin-bottom:0}
</style>
