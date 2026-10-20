<script lang="ts">
  /** 文件职责：承载全页画布及保存屏障，沿用应用主题，不管理图形和磁盘格式。 */
  import { onMount, tick } from 'svelte';
  import { t, locale } from '../i18n';
  import WindowControls from '../WindowControls.svelte';
  import type { CanvasAssetPort, CanvasSession } from './types';
  import type { CanvasEngine } from './engine-port';
  import type { CanvasSaveStatus } from './save-queue';

  /** 结构职责：提供文档会话、附件与宿主保存入口；关闭前须成功提交队列和文档保存。 */
  interface Props {
    session: CanvasSession;
    documentPath: string;
    assets: CanvasAssetPort;
    theme: 'light' | 'dark';
    desktop: boolean;
    documentSaved: boolean;
    onClose(): void;
    onSave(): Promise<boolean>;
    onDownload(blob: Blob, name: string): Promise<void>;
    onError(message: string): void;
  }
  let { session, documentPath, assets, theme, desktop, documentSaved, onClose, onSave, onDownload, onError }: Props = $props();
  let host: HTMLDivElement;
  let imageInput: HTMLInputElement;
  let panel: HTMLElement;
  let engine = $state.raw<CanvasEngine>();
  let title = $state('');
  let status = $state<CanvasSaveStatus>('saved');
  let error = $state('');
  let loading = $state(true);
  let busy = $state(false);
  let locked = $state(false);
  let destroyed = false;

  /** 函数职责：为应用退出与系统返回提供同一保存屏障；失败保留完整编辑现场。 */
  export async function flush(): Promise<boolean> { return !engine || await engine.flush(); }
  /** 宿主退出或安装更新时，在保存屏障前锁住所有画布输入；失败可原地解锁继续编辑。 */
  export function setLocked(value: boolean): void { locked = value; }
  export async function close(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await tick();
      if (!await flush()) return;
      if (!await onSave()) { error = $t('正文保存失败，请重试。'); return; }
      onClose();
    } finally { busy = false; }
  }
  async function load(): Promise<void> {
    loading = true; error = '';
    try {
      const { mountCanvasEngine } = await import('./engine');
      if (destroyed) return;
      const mounted = await mountCanvasEngine({ host, session, documentPath, assets, theme, language: $locale,
        onStatus(next, cause) { if (!destroyed) { status = next; error = cause?.message ?? ''; } },
      });
      if (destroyed) { mounted.dispose(); return; }
      engine = mounted;
      engine.setTitle(title);
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { loading = false; }
  }
  async function exportPNG(): Promise<void> {
    if (!engine || busy) return;
    busy = true;
    try { await onDownload(await engine.exportPNG(), `${title.trim() || $t('画布')}.png`); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  async function insertImages(files: File[]): Promise<void> {
    if (!engine || session.readOnly || busy || locked) return;
    // 一次用户选择中的所有任务先登记；引擎内部串行读取，关闭屏障才能等待整批输入。
    try { await Promise.all(files.map(file => engine!.addImage(file))); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  function pasteImages(event: ClipboardEvent): void {
    const images = [...event.clipboardData?.files ?? []];
    if (!images.length) return;
    event.preventDefault(); event.stopPropagation(); void insertImages(images);
  }
  function dropImages(event: DragEvent): void {
    const images = [...event.dataTransfer?.files ?? []];
    if (!images.length) return;
    event.preventDefault(); event.stopPropagation(); void insertImages(images);
  }
  function keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === '9' && !event.ctrlKey && !event.metaKey && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !session.readOnly) {
      event.preventDefault(); event.stopPropagation(); imageInput.click(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation();
      void (async () => { if (await flush()) await onSave(); })();
    }
    if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement) && engine?.canCloseWithEscape()) {
      event.preventDefault(); event.stopPropagation(); void close();
    }
    // 白板为独占页面；Tab 只能在当前页面的控件内移动，不能进入遮住的正文。
    if (event.key === 'Tab') {
      const nodes = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(node => node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  $effect(() => { engine?.setAppearance(theme, $locale); });
  $effect(() => { engine?.setLocked(busy || locked); });
  onMount(() => {
    title = session.document.title;
    void load();
    return () => { destroyed = true; engine?.dispose(); };
  });
</script>

<!-- 引擎自行处理 Esc 的工具取消；捕获阶段只在无工具或选区时执行收起。 -->
<div class="canvas-page" class:canvas-desktop={desktop} role="dialog" aria-modal="true" aria-label={$t('画布')} tabindex="-1" bind:this={panel} onkeydowncapture={keydown} onpastecapture={pasteImages} ondropcapture={dropImages} inert={busy || locked}>
  <input class="canvas-bundle-input" type="file" accept="image/png,image/jpeg,image/webp" multiple bind:this={imageInput} onchange={event => { const input = event.currentTarget; void insertImages([...input.files ?? []]); input.value = ''; }}/>
  <header class="canvas-header" data-tauri-drag-region={desktop ? true : undefined}>
    <div class="canvas-heading">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 15 4-6 3 4 3-2"/></svg>
      <input aria-label={$t('画布标题')} value={title} readonly={session.readOnly} disabled={loading} maxlength="120" placeholder={$t('画布')} oninput={event => { title = event.currentTarget.value; engine?.setTitle(title); }}/>
      <span class="canvas-save-state" role="status" aria-label={status === 'saved' && documentSaved ? $t('已保存') : $t('未保存')} title={session.readOnly ? $t('只读') : status === 'saved' && documentSaved ? $t('已保存') : $t('未保存')} class:canvas-pending={status !== 'saved' || !documentSaved}>
        {#if session.readOnly}<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="9" width="10" height="8" rx="2"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/></svg>{:else}<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m5 10 3 3 7-7"/></svg>{/if}
      </span>
    </div>
    <div class="canvas-header-actions">
      {#if !session.readOnly}<button class="icon-button" disabled={!engine || busy} aria-label={$t('插入图片')} title={$t('插入图片')} onclick={() => imageInput.click()}><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="7" cy="7" r="1"/><path d="m4 14 4-4 3 3 2-2 4 4"/></svg></button>{/if}
      <button class="icon-button" disabled={!engine || busy} aria-label={$t('导出画布图片')} title={$t('导出画布图片')} onclick={exportPNG}><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3v9m-3-3 3 3 3-3M4 12v4h12v-4"/></svg></button>
      <button class="icon-button" disabled={busy} aria-label={$t('收起画布')} title={$t('收起画布')} onclick={() => void close()}><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h4V3m10 4h-4V3M3 13h4v4m10-4h-4v4"/></svg></button>
      {#if desktop}<WindowControls onerror={onError}/>{/if}
    </div>
  </header>
  {#if error}<div class="canvas-error" role="alert"><span>{error}</span><button onclick={() => { if (engine) void flush(); else void load(); }}>{$t('重试')}</button></div>{/if}
  <div class="canvas-engine-host" bind:this={host}></div>
  {#if loading}<div class="canvas-loading" role="status">{$t('正在打开画布…')}</div>{/if}
</div>
