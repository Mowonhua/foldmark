<script lang="ts">
  /** 同步面板只呈现设备、文档选择和冲突入口；正文写入仍由同步协调器负责。 */
  import QRCode from 'qrcode';
  import { invoke } from '@tauri-apps/api/core';
  import { errorMessage } from './session/save-coordinator';
  import { encodePairingOffer, decodePairingOffer } from './sync/pairing-code';
  import type { SyncController } from './sync/controller';
  import { assembleMerge, commonAncestor, defaultChoices, diffHunks, type MergeChoice, type MergeHunk, type MergeHunkKind } from './sync/merge';
  import type { DocumentContent, PairingOffer, SyncRecord } from './sync/contracts';
  let { controller, revision, projects, ensureInspiration, focus, onClose }: {
    controller: SyncController; revision: number; projects: { id: string; name: string }[];
    ensureInspiration: () => Promise<void>; onClose: () => void;
    focus: (node: HTMLElement) => { destroy(): void };
  } = $props();
  const snapshot = $derived.by(() => { void revision; return controller.engine.snapshot(); });
  const connection = $derived.by(() => { void revision; return controller.connection; });
  const current = $derived.by(() => { void revision; return { status: controller.status, error: controller.error, busy: controller.busy, pending: controller.pendingEdits }; });
  const records = $derived(Object.values(snapshot.records));
  const pending = $derived(records.filter(record => !record.binding));
  const attention = $derived(records.filter(record => record.binding?.enabled && (record.conflict || record.error)));
  const selected = $derived(records.filter(record => record.binding?.enabled).length);
  let qr = $state(''); let offer = $state<PairingOffer | null>(null); let input = $state(''); let address = $state('');
  let error = $state(''); let working = $state(false);
  let conflict = $state<{ id: string; local: string; remote: string; base: string; mine: DocumentContent; theirs: DocumentContent } | null>(null);
  let hunks = $state<MergeHunk[]>([]);
  let choices = $state<(MergeChoice | null)[]>([]);
  let mergedText = $state(''); let mergedName = $state(''); let mergedArchived = $state(false);
  let comparisonTab = $state<'mine' | 'theirs' | 'merge'>('mine');
  /** 未决定的差异块在合并结果中的占位文本；它不是正文内容，出现时不允许保存。 */
  const pendingMark = '〔两端改了同一段内容：请在该处选择保留哪一侧〕';
  const hunkLabels: Record<MergeHunkKind, string> = { local: '仅本机改动', remote: '仅对端改动', same: '两端改动相同', union: '两端改动可以并存', overlap: '两端改了同一段内容' };
  /** 差异块一侧没有内容时的显示文本，用于区分“没有改动”和“删除了本段”。 */
  const emptySide = '（无）';
  /** 差异块尚未决定时不能保存：此时的合并结果含占位文本，保存等于丢弃未选择的一侧。 */
  const unresolved = $derived(choices.some(choice => choice === null));
  /** 合并结果为空时不能保存：空框只表示用户还没有决定保留什么，此时写入会把文档清空。 */
  const mergeReady = $derived(!!mergedName.trim() && !!mergedText.trim() && !unresolved);
  let receiving = $state<string | null>(null);
  let receiveTarget = $state('');
  // 对端撤回尚未接收的文档时，已打开的位置选择页也必须退出，不能保留空接收表单。
  $effect(() => { if (receiving && !snapshot.records[receiving]) receiving = null; });
  const availableProjects = $derived(projects.filter(project => !records.some(record => record.binding?.localId === project.id)));
  function documentStatus(record?: SyncRecord): string {
    if (!record?.binding?.enabled) return '仅本机';
    if (record.conflict) return '需合并';
    if (record.error) return '待处理';
    // 对端确认的是当前 head 且本机没有新改动才算已同步；只看状态文案无法区分待发送与离线。
    return record.binding.acknowledged === record.document.head && !current.pending ? '已同步' : '待同步';
  }
  async function act(operation: () => Promise<unknown>): Promise<void> {
    if (working) return; working = true; error = '';
    try { await operation(); } catch (cause) { error = errorMessage(cause); } finally { working = false; }
  }
  async function showOffer(): Promise<void> {
    offer = await controller.transport.offer();
    qr = await QRCode.toDataURL(encodePairingOffer(offer), { width: 480, margin: 4, errorCorrectionLevel: 'L' });
  }
  async function scan(): Promise<void> {
    await invoke('plugin:taskrail-mobile|prepare');
    const result = await invoke<{ content: string | null }>('plugin:taskrail-mobile|scan');
    if (result.content) await controller.pair(decodePairingOffer(result.content));
  }
  async function toggle(id: string, enabled: boolean, kind: 'project' | 'inspiration' = 'project'): Promise<void> {
    const entry = Object.values(snapshot.records).find(record => record.binding?.localId === id);
    if (enabled) { if (kind === 'inspiration') await ensureInspiration(); await controller.engine.enable(id, kind); }
    else if (entry) await controller.engine.disable(entry.document.id);
    await controller.sync();
  }
  /**
   * 函数职责：打开冲突文档并计算逐块合并的初始状态。
   * 输入说明：id 必须是当前快照中已记录冲突的文档。
   * 输出说明：有共同祖先时列出差异块并给出默认选择，否则退回两端全文对照的整篇模式。
   * 实现思路：差异块只覆盖两端改动过的区间，其余内容由 assembleMerge 取自共同祖先；
   *   默认选择不预填任一端，只有两端改了同一段内容的差异块留空等待用户决定。
   */
  function compare(id: string): void {
    const record = snapshot.records[id]; if (!record.conflict) return;
    const mine = record.document.revisions[record.conflict.local].content;
    const theirs = record.document.revisions[record.conflict.remote].content;
    const base = commonAncestor(record.document, record.conflict.local, record.conflict.remote);
    let list: MergeHunk[] | null = null;
    // 差异无法按行比较时退回整篇对照，避免把祖先原文当成合并结果交给用户。
    if (base) { try { list = diffHunks(base.content.text, mine.text, theirs.text); } catch { list = null; } }
    conflict = { id, ...record.conflict, base: base?.content.text ?? '', mine, theirs };
    hunks = list ?? [];
    choices = list ? defaultChoices(list) : [];
    mergedText = base && list ? assembleMerge(base.content.text, list, choices, pendingMark) : '';
    mergedName = mine.name; mergedArchived = mine.archived; comparisonTab = 'mine';
  }
  /**
   * 函数职责：改变一个差异块的来源并重新拼装合并结果。
   * 输入说明：index 对应 hunks 的下标，choice 只能是该差异块支持的来源。
   * 输出说明：合并结果按“所有差异块的选择 + 共同祖先的未改动内容”整体重建，覆盖此前的正文编辑。
   */
  function pick(index: number, choice: MergeChoice): void {
    if (!conflict) return;
    choices[index] = choice;
    mergedText = assembleMerge(conflict.base, hunks, choices, pendingMark);
  }
  async function resolve(content: DocumentContent): Promise<void> {
    if (!conflict) return;
    await controller.engine.resolve(conflict.id, conflict.local, conflict.remote, content); conflict = null; await controller.sync();
  }
</script>


{#snippet icon(kind: string, size = 20)}
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if kind === 'phone'}<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10 5h4m-3 13.5h2"/>
    {:else if kind === 'desktop'}<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>
    {:else if kind === 'refresh'}<path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5m-3 9a9 9 0 0 0 15 2l3-3m0 5v-5h-5"/>
    {:else if kind === 'document'}<path d="M14 2H5v20h14V7zM14 2v6h5M8 12h8m-8 4h6"/>
    {:else if kind === 'alert'}<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>
    {:else if kind === 'qr'}<path d="M3 8V3h5m8 0h5v5m0 8v5h-5M8 21H3v-5"/><path d="M7 7h3v3H7zm7 0h3v3h-3zM7 14h3v3H7zm7 0h3v3h-3z"/>
    {:else if kind === 'back'}<path d="m14 6-6 6 6 6"/>
    {:else if kind === 'chevron'}<path d="m9 5 7 7-7 7"/>
    {:else}<path d="m6 6 12 12M6 18 18 6"/>{/if}
  </svg>
{/snippet}

<div class="modal-backdrop sync-backdrop" class:sync-mobile={!controller.desktop} role="presentation">
  <div class="modal sync-panel" class:sync-merging={!!conflict} role="dialog" aria-modal="true" aria-label="设备同步" tabindex="-1" use:focus onkeydown={event => { if (event.key === 'Escape') { event.preventDefault(); if (conflict) conflict = null; else if (receiving) receiving = null; else onClose(); } }}>
    <header class="sync-heading">
      <div class="sync-title">{#if conflict || receiving}<button class="icon-button" aria-label="返回同步文档" onclick={() => { conflict = null; receiving = null; }}>{@render icon('back')}</button>{/if}<h2>{conflict ? '合并文档' : receiving ? '接收文档' : '设备同步'}</h2></div>
      <button class="icon-button" aria-label="关闭同步面板" onclick={onClose}>{@render icon('close')}</button>
    </header>
    <div class="sync-body" class:sync-overview={connection.paired && !conflict && !receiving}>
      {#if receiving}
        <section class="sync-details">
          <h3>{snapshot.records[receiving]?.document.revisions[snapshot.records[receiving].document.head].content.name}</h3>
          <label>保存到<select aria-label="接收文档保存到" bind:value={receiveTarget}><option value="">新建项目</option>{#each availableProjects as project}<option value={project.id}>关联：{project.name}</option>{/each}</select></label>
        </section>
      {:else if conflict}
        <div class="sync-conflict-title"><h3>{conflict.mine.name}</h3><span class="sync-badge needs-attention">需合并</span>
          {#if hunks.length}<div class="sync-inline-actions"><button class="sync-text-button" disabled={working} onclick={() => act(() => resolve(conflict!.mine))}>选用本机</button><button class="sync-text-button" disabled={working} onclick={() => act(() => resolve(conflict!.theirs))}>选用对端</button></div>{/if}
        </div>
        {#if hunks.length}
          <div class="sync-hunks">
            {#each hunks as hunk, index (index)}
              <section class="sync-hunk" class:sync-hunk-needs={hunk.kind === 'overlap'}>
                <div class="sync-hunk-heading"><h4>第 {index + 1} 处 · {hunkLabels[hunk.kind]}</h4>
                  <div class="sync-hunk-choices" role="group" aria-label="第 {index + 1} 处采用的改动">
                    <button aria-pressed={choices[index] === 'local'} disabled={working} onclick={() => pick(index, 'local')}>本机</button>
                    <button aria-pressed={choices[index] === 'remote'} disabled={working} onclick={() => pick(index, 'remote')}>对端</button>
                    {#if hunk.union !== undefined}<button aria-pressed={choices[index] === 'union'} disabled={working} onclick={() => pick(index, 'union')}>两端</button>{/if}
                  </div>
                </div>
                <div class="sync-hunk-sides"><p class="sync-hunk-side"><b>本机</b>{hunk.local || emptySide}</p><p class="sync-hunk-side"><b>对端</b>{hunk.remote || emptySide}</p></div>
              </section>
            {/each}
          </div>
        {:else}
        <div class="sync-compare-tabs" role="tablist" aria-label="文档版本">
          {#each [['mine', '本机'], ['theirs', '对端'], ['merge', '合并结果']] as tab}<button role="tab" aria-selected={comparisonTab === tab[0]} onclick={() => comparisonTab = tab[0] as typeof comparisonTab}>{tab[1]}</button>{/each}
        </div>
        <div class="sync-comparison">
          <section class="sync-version" class:sync-tab-inactive={comparisonTab !== 'mine'}><div class="sync-version-heading"><h4>本机</h4><button disabled={working} onclick={() => act(() => resolve(conflict!.mine))}>选用本机</button></div>{#if conflict.mine.name !== conflict.theirs.name || conflict.mine.archived !== conflict.theirs.archived}<p class="sync-version-meta">{conflict.mine.name} · {conflict.mine.archived ? '已归档' : '未归档'}</p>{/if}<textarea aria-label="本机正文" readonly value={conflict.mine.text}></textarea></section>
          <section class="sync-version" class:sync-tab-inactive={comparisonTab !== 'theirs'}><div class="sync-version-heading"><h4>对端</h4><button disabled={working} onclick={() => act(() => resolve(conflict!.theirs))}>选用对端</button></div>{#if conflict.mine.name !== conflict.theirs.name || conflict.mine.archived !== conflict.theirs.archived}<p class="sync-version-meta">{conflict.theirs.name} · {conflict.theirs.archived ? '已归档' : '未归档'}</p>{/if}<textarea aria-label="对端正文" readonly value={conflict.theirs.text}></textarea></section>
        </div>
        {/if}
        <section class="sync-version sync-merge-version" class:sync-tab-inactive={!hunks.length && comparisonTab !== 'merge'}><div class="sync-version-heading"><h4>合并结果</h4></div><textarea aria-label="合并结果" class="sync-merge" readonly={unresolved} bind:value={mergedText}></textarea>
          <details class="sync-details"><summary>名称与归档状态</summary><label>项目名称<input bind:value={mergedName}/></label><label class="check-label"><input class="sync-check-input" type="checkbox" bind:checked={mergedArchived}/><span class="fm-task-checkbox sync-checkmark" data-checked={mergedArchived} aria-hidden="true"></span>项目已归档</label></details>
        </section>
      {:else if !connection.paired}
        <section class="sync-pairing" class:has-qr={!!qr && controller.desktop}>
          {#if qr && offer && controller.desktop}<div class="sync-qr-frame"><img class="sync-qr" src={qr} alt="手机扫码配对"/><span>五分钟内有效</span></div>{/if}
          <div class="sync-pairing-content">
            <div class="sync-device-icon">{@render icon(controller.desktop ? 'phone' : 'desktop', 30)}</div>
            <h3>{controller.desktop ? '连接手机' : '连接电脑'}</h3>
            <p>{controller.desktop ? '在手机上扫描配对二维码' : '打开电脑上的 Taskrail 配对二维码'}</p>
            {#if controller.desktop}<button class="primary sync-button" disabled={working} onclick={() => act(showOffer)}>{@render icon('qr', 18)}{qr ? '刷新二维码' : '显示配对二维码'}</button>
            {:else}<button class="primary sync-button" disabled={working} onclick={() => act(scan)}>{@render icon('qr', 18)}扫描电脑二维码</button>{/if}
            {#if current.status === '等待电脑确认'}<span class="sync-waiting" role="status">等待电脑确认</span>{/if}
          </div>
        </section>
        {#if connection.pending}<section class="sync-pair-request"><div><strong>手机请求连接</strong><span>{connection.pending.slice(0, 8)}</span></div><div class="sync-inline-actions"><button class="sync-button" disabled={working} onclick={() => act(async () => { await controller.transport.approve(false); qr = ''; await controller.sync(); })}>拒绝</button><button class="primary sync-button" disabled={working} onclick={() => act(async () => { await controller.transport.approve(true); qr = ''; await controller.sync(); })}>允许连接</button></div></section>{/if}
        {#if controller.desktop && offer}<details class="sync-details"><summary>连接选项</summary>{#if (offer.addresses?.length ?? 0) > 1}<label>电脑地址<select bind:value={offer.address} onchange={() => act(async () => { qr = await QRCode.toDataURL(encodePairingOffer(offer!), { width: 480, margin: 4, errorCorrectionLevel: 'L' }); })}>{#each offer.addresses ?? [] as endpoint}<option value={endpoint}>{endpoint}</option>{/each}</select></label>{:else}<p class="sync-address">{offer.address}</p>{/if}<button class="sync-text-button" disabled={working} onclick={() => act(async () => { const { writeText } = await import('@tauri-apps/plugin-clipboard-manager'); await writeText(encodePairingOffer(offer!)); })}>复制配对信息</button></details>
        {:else if !controller.desktop}<details class="sync-details"><summary>手动输入配对信息</summary><textarea aria-label="配对信息" class="sync-pair-input" placeholder="粘贴电脑的配对信息" bind:value={input}></textarea><button class="sync-button" disabled={working || !input.trim()} onclick={() => act(async () => { await invoke('plugin:taskrail-mobile|prepare'); await controller.pair(decodePairingOffer(input)); })}>连接</button></details>{/if}
      {:else}
        <section class="sync-device">
          <div class="sync-device-icon">{@render icon(controller.desktop ? 'phone' : 'desktop', 26)}</div>
          <div class="sync-device-text"><strong>{controller.desktop ? 'Android 手机' : 'Windows 电脑'}</strong><span role="status"><i class:sync-status-warning={!!current.error || attention.length > 0}></i>{current.status}</span></div>
          <button class="sync-button sync-now" disabled={current.busy || working} onclick={() => act(() => controller.sync())}><span class:sync-spinning={current.busy || working}>{@render icon('refresh', 17)}</span>立即同步</button>
        </section>
        <div class="sync-document-scroll">
        {#if pending.length}<section class="sync-section"><div class="sync-section-heading"><h3>待接收</h3><span>{pending.length}</span></div>{#each pending as record (record.document.id)}<div class="sync-receive-row"><span class="sync-file-icon">{@render icon('document', 19)}</span><strong>{record.document.revisions[record.document.head].content.name}</strong><button class="sync-button" disabled={working} onclick={() => { if (record.document.kind === 'inspiration') void act(async () => { await controller.engine.accept(record.document.id); await controller.sync(); }); else { receiveTarget = ''; receiving = record.document.id; } }}>接收文档</button></div>{/each}</section>{/if}
        {#if attention.length}<section class="sync-section"><div class="sync-section-heading"><h3>待处理</h3><span>{attention.length}</span></div>{#each attention as record (record.document.id)}<div class="sync-attention-row"><div class="sync-attention-title"><span class="sync-alert-icon">{@render icon('alert', 18)}</span><strong>{record.document.revisions[record.document.head].content.name}</strong>{#if record.conflict}<button class="sync-text-button" disabled={working} onclick={() => compare(record.document.id)}>比较并处理 {@render icon('chevron', 14)}</button>{/if}</div>{#if record.error}<details class="sync-error-detail"><summary>同步未完成</summary><p>{record.error}</p></details>{/if}</div>{/each}</section>{/if}
        <section class="sync-section"><div class="sync-section-heading"><h3>同步文档</h3><span>{selected} 项已选择</span></div>
          <div class="sync-documents">{#each [...projects, { id: 'inspiration', name: '灵感' }] as project}
            {@const record = records.find(entry => entry.binding?.localId === project.id)}
            <label class="check-label sync-document-row"><input class="sync-check-input" type="checkbox" disabled={working} checked={record?.binding?.enabled ?? false} onchange={event => act(() => toggle(project.id, event.currentTarget.checked, project.id === 'inspiration' ? 'inspiration' : 'project'))}/><span class="fm-task-checkbox sync-checkmark" data-checked={record?.binding?.enabled ?? false} aria-hidden="true"></span><span class="sync-document-name">{project.name}</span><span class="sync-document-state" class:needs-attention={!!record?.conflict || !!record?.error}>{documentStatus(record)}</span></label>
          {/each}</div>
        </section>
        </div>
      {/if}
      {#if error || current.error}<div class="sync-error" role="alert">{@render icon('alert', 18)}<p>{error || current.error}</p></div>{/if}
    </div>
    {#if connection.paired && !conflict && !receiving}
      <details class="sync-details sync-connection-settings"><summary>连接设置</summary>
        {#if !controller.desktop}<label for="sync-address">电脑局域网地址</label><div class="sync-address-controls"><input id="sync-address" aria-label="电脑局域网地址" placeholder={connection.address || '192.168.1.10:12345'} bind:value={address} autocapitalize="off" spellcheck={false}/><button class="sync-button" disabled={working || !address.trim()} onclick={() => act(async () => { await controller.transport.address(address.trim()); address = ''; await controller.sync(); })}>连接</button></div>{/if}
        <button class="sync-text-button sync-disconnect" disabled={working} onclick={() => act(() => controller.unpair())}>解除配对</button>
      </details>
    {/if}
    {#if receiving}<footer class="sync-footer"><button class="sync-button" onclick={() => receiving = null}>取消</button><button class="primary sync-button" disabled={working} onclick={() => act(async () => { const id = receiving!; await controller.engine.accept(id, receiveTarget || undefined); receiving = null; await controller.sync(); if (controller.engine.snapshot().records[id]?.conflict) compare(id); })}>{receiveTarget ? '关联项目' : '新建并接收'}</button></footer>
    {:else if conflict}<footer class="sync-footer"><button class="sync-button" onclick={() => conflict = null}>暂不处理</button><button class="primary sync-button" disabled={working || !mergeReady} onclick={() => act(() => resolve({ text: mergedText, name: mergedName, archived: mergedArchived }))}>保存合并</button></footer>{/if}
  </div>
</div>
