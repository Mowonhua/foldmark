<script lang="ts">
  /**
   * 文件职责：呈现阅读与外观设置，组织常用字段及按需展开的主题操作。
   * 定义范围：偏好绑定、设置分组与文件操作回调；不访问持久化或原生窗口。
   */
  import type { Preferences } from './contracts';
  import type { ThemeDefinition } from './themes';
  import type { WindowMaterial } from './window-material';
  import { t, type LocalePreference } from './i18n';
  import { builtInThemes, type ThemeMode } from './themes';
  import { composeFontStack, DEFAULT_FONT_STACK, GENERIC_FAMILIES, parseFontStack, probeFontInstalled, quoteFontFamily } from './font-stack';
  import FontSelect from './FontSelect.svelte';
  import ThemeSelect from './ThemeSelect.svelte';

  /**
   * 结构职责：将设置展示与应用的配置、主题文件及原生能力边界连接。
   * 字段说明：preferences 与 App 共用绑定；themes 已经校验；回调由 App 承担 IO 与错误反馈。
   * 约束条件：桌面能力及材质仅控制可用状态，不按主题名称分支；禁用时保留已有偏好。
   */
  interface Props {
    preferences: Preferences;
    themes: ThemeDefinition[];
    material: WindowMaterial;
    desktop: boolean;
    configReady: boolean;
    importBusy: boolean;
    exportBusy: boolean;
    canRemoveTheme: boolean;
    onImport: (event: Event) => Promise<void>;
    onExport: () => Promise<void>;
    onRemove: () => void;
  }

  let { preferences = $bindable(), themes, material, desktop, configReady, importBusy, exportBusy, canRemoveTheme, onImport, onExport, onRemove }: Props = $props();
  let helpDetails: HTMLDetailsElement;
  let themeInput: HTMLInputElement;
  const transparencyAvailable = $derived(desktop && material === 'acrylic');
  /** 当前字体栈的槽位视图；手动输入与选择器共用同一字符串真源。 */
  const fontSlots = $derived(parseFontStack(preferences.fontFamily));
  /** 字体栈偏离默认值时提供一键恢复；空栈同样视为默认以外的状态。 */
  const fontStackModified = $derived(preferences.fontFamily !== DEFAULT_FONT_STACK);

  /**
   * 函数职责：替换字体栈指定槽位的具名字体并重组字符串。
   * 输入说明：index 0 为主字体、1 为备用字体；family 为 null 表示移除该槽位。
   * 输出说明：写回 preferences.fontFamily，由 App 的既有效果热应用并持久化。
   * 实现思路：基于解析结果原地替换；槽位不足时追加，移除时其后条目前移。
   */
  function replaceNamedSlot(index: number, family: string | null): void {
    const { named, generic } = parseFontStack(preferences.fontFamily);
    const next = [...named];
    if (family === null) {
      if (index < next.length) next.splice(index, 1);
    } else if (index < next.length) {
      next[index] = family;
    } else {
      next.push(family);
    }
    preferences.fontFamily = composeFontStack(next, generic);
  }

  /**
   * 函数职责：设置栈尾通用兜底关键字。
   * 输入说明：generic 为 null 表示移除兜底，栈中只剩具名字体。
   * 输出说明：写回 preferences.fontFamily，具名字体保持原顺序。
   */
  function setGenericFamily(generic: string | null): void {
    preferences.fontFamily = composeFontStack(fontSlots.named, generic);
  }

  /**
   * 函数职责：在徽章行上把纵向滚轮转为横向滚动，查看被裁剪的徽章。
   * 输入说明：wheel 事件；带横向分量或无溢出时交给浏览器默认行为。
   * 输出说明：滚动条不绘制；已滚到一端时放行滚动链，外层容器继续滚动。
   */
  function onChipsWheel(event: WheelEvent): void {
    const chips = event.currentTarget as HTMLDivElement;
    const maxScroll = chips.scrollWidth - chips.clientWidth;
    if (maxScroll <= 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const target = chips.scrollLeft + event.deltaY;
    if ((target <= 0 && chips.scrollLeft <= 0) || (target >= maxScroll && chips.scrollLeft >= maxScroll)) return;
    event.preventDefault();
    chips.scrollLeft = Math.max(0, Math.min(maxScroll, target));
  }

  /**
   * 函数职责：让帮助浮层先消费 Escape，保留其所属的设置对话框。
   * 输入说明：事件来自帮助 summary；说明不包含可聚焦操作，只有帮助已展开时处理。
   * 输出说明：收起帮助并恢复 summary 焦点；其他按键保持浏览器默认行为。
   * 实现思路：检测 Escape 与 open，阻止事件冒泡后关闭原生 details。
   */
  function handleHelpKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !helpDetails.open) return;
    event.preventDefault(); event.stopPropagation();
    helpDetails.open = false;
    helpDetails.querySelector<HTMLElement>('summary')?.focus();
  }

  /**
   * 函数职责：在帮助以外发生指针操作时收起浮层。
   * 输入说明：事件来自窗口；帮助内部操作及未展开状态不产生变化。
   * 输出说明：仅关闭帮助，不拦截目标控件的交互或改变焦点。
   * 实现思路：以 details 包含关系识别外部指针目标。
   */
  function dismissHelp(event: PointerEvent): void {
    if (helpDetails?.open && event.target instanceof Node && !helpDetails.contains(event.target)) helpDetails.open = false;
  }
</script>

<svelte:window onpointerdown={dismissHelp}/>

<div class="settings-panel">
  <header class="settings-heading"><h2 id="dialog-title">{$t('阅读与外观')}</h2></header>

  <section class="settings-section" aria-labelledby="settings-interface-heading">
    <h3 id="settings-interface-heading">{$t('界面')}</h3>
    <ThemeSelect inline id="settings-locale" label={$t('语言')} bind:value={() => preferences.locale ?? 'zh-CN', value => preferences.locale = value as LocalePreference}
      options={[{ value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }, { value: 'system', label: $t('跟随系统') }]} />
    <ThemeSelect inline id="settings-theme" label={$t('主题')} bind:value={() => preferences.themeId ?? 'paper', value => preferences.themeId = value}
      options={themes.map(theme => ({ value: theme.id, label: builtInThemes.some(builtIn => builtIn.id === theme.id) ? $t(theme.name) : theme.name }))} />
    <ThemeSelect inline id="settings-mode" label={$t('明暗模式')} bind:value={() => preferences.theme, value => preferences.theme = value as ThemeMode}
      options={[{ value: 'system', label: $t('跟随系统') }, { value: 'light', label: $t('浅色') }, { value: 'dark', label: $t('深色') }]} />

    <div class="settings-row settings-transparency-row">
      <div class="settings-label-with-help">
        <label for="settings-keep-transparent-on-blur">{$t('窗口失焦时保持透明')}</label>
        <details class="settings-help" bind:this={helpDetails}>
          <summary aria-label={$t('关于窗口透明')} title={$t('关于窗口透明')} onkeydown={handleHelpKeydown}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7.3"/><path d="M10 9v5"/><circle cx="10" cy="6.1" r=".6" fill="currentColor" stroke="none"/></svg></summary>
          <div id="settings-transparency-help" class="settings-help-popup" role="note">
            <p>{$t('开启后，窗口失去焦点仍保持透明模糊；关闭时使用系统默认效果。')}</p>
            {#if !desktop}<p>{$t('浏览器预览不支持原生窗口透明，请在 Windows 桌面版使用。')}</p>
            {:else if material !== 'acrylic'}<p>{$t('请选择支持玻璃窗口效果的主题，例如液态玻璃或磨砂玻璃。')}</p>{/if}
          </div>
        </details>
      </div>
      <div class="settings-switch-control">
        <span class="settings-switch-status" aria-hidden="true">{!desktop ? $t('仅桌面版') : material !== 'acrylic' ? $t('仅玻璃主题') : preferences.keepTransparentOnBlur ? $t('开启') : $t('关闭')}</span>
        <label class="settings-switch" class:settings-switch-disabled={!transparencyAvailable}>
          <!-- 保留原生 checkbox 的点击、空格键及绑定行为；轨道独立于复选框视觉规则，直角主题仍由通用边角契约覆盖。 -->
          <input id="settings-keep-transparent-on-blur" type="checkbox" role="switch" aria-describedby="settings-transparency-help" disabled={!transparencyAvailable} bind:checked={preferences.keepTransparentOnBlur}/>
          <span class="settings-switch-track" aria-hidden="true"><span class="settings-switch-thumb"></span></span>
        </label>
      </div>
    </div>
    <div class="settings-row"><label for="settings-heading-add">{$t('标题后新增任务按钮')}</label><div class="settings-switch-control"><span class="settings-switch-status" aria-hidden="true">{preferences.headingAdd ? $t('开启') : $t('关闭')}</span><label class="settings-switch"><input id="settings-heading-add" type="checkbox" role="switch" bind:checked={preferences.headingAdd}/><span class="settings-switch-track" aria-hidden="true"><span class="settings-switch-thumb"></span></span></label></div></div>
  </section>

  <section class="settings-section" aria-labelledby="settings-reading-heading">
    <h3 id="settings-reading-heading">{$t('正文')}</h3>
    <FontSelect inline id="settings-font-primary" label={$t('正文字体')} bind:value={() => fontSlots.named[0] ?? null, family => replaceNamedSlot(0, family)} />
    <FontSelect inline id="settings-font-fallback" label={$t('备用字体')} allowEmpty bind:value={() => fontSlots.named[1] ?? null, family => replaceNamedSlot(1, family)} />
    <ThemeSelect inline id="settings-font-generic" label={$t('兜底字体')} bind:value={() => fontSlots.generic ?? 'none', family => setGenericFamily(family === 'none' ? null : family)}
      options={[{ value: 'none', label: $t('无') }, ...GENERIC_FAMILIES.map(family => ({ value: family, label: family }))]} />
    <details class="settings-font-manual">
      <summary>
        <span>{$t('手动输入字体')}</span>
        <span class="settings-font-current">{preferences.fontFamily || $t('未选择')}</span>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
      </summary>
      <div class="settings-font-editor">
        <input id="settings-font" class="settings-font-input" bind:value={preferences.fontFamily} placeholder={DEFAULT_FONT_STACK} aria-label={$t('手动输入字体')}/>
        <div class="settings-font-status" role="status">
          <div class="settings-font-chips" onwheel={onChipsWheel}>
            {#each fontSlots.named as family (family)}
              <span class="settings-font-chip" class:settings-font-chip-missing={!probeFontInstalled(family)} style:font-family={quoteFontFamily(family)}>
                <span aria-hidden="true">{probeFontInstalled(family) ? '✓' : '✗'}</span>{family}
              </span>
            {/each}
            {#if fontSlots.generic}<span class="settings-font-chip settings-font-chip-generic">{fontSlots.generic}</span>{/if}
            {#if fontSlots.named.length === 0 && !fontSlots.generic}
              <span class="settings-font-status-empty">{$t('尚未选择字体，正文使用应用默认字体。')}</span>
            {/if}
          </div>
          {#if fontStackModified}
            <button type="button" class="settings-font-reset" onclick={() => preferences.fontFamily = DEFAULT_FONT_STACK}>{$t('恢复默认')}</button>
          {/if}
        </div>
      </div>
    </details>
    <div class="settings-row"><label for="settings-font-size">{$t('字号')}</label><div class="settings-range-control"><input id="settings-font-size" type="range" min="13" max="24" step="1" bind:value={preferences.fontSize}/><output for="settings-font-size">{preferences.fontSize} px</output></div></div>
    <div class="settings-row"><label for="settings-content-width">{$t('正文宽度')}</label><div class="settings-range-control"><input id="settings-content-width" type="range" min="640" max="960" step="20" bind:value={preferences.contentWidth}/><output for="settings-content-width">{preferences.contentWidth} px</output></div></div>
  </section>

  <details class="settings-theme-manager">
    <summary><span>{$t('主题管理')}</span><span class="settings-manager-caption">{$t('导入与导出')}</span><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></summary>
    <div class="settings-theme-actions file-buttons">
      <input class="offscreen" type="file" accept=".json,application/json" aria-label={$t('导入主题文件')} bind:this={themeInput} onchange={onImport}/>
      <button disabled={importBusy || !configReady} onclick={() => themeInput?.click()}>{$t(importBusy ? '正在导入…' : '导入主题')}</button>
      <button disabled={exportBusy || !configReady} onclick={onExport}>{$t('下载主题模板')}</button>
      {#if canRemoveTheme}<button onclick={onRemove}>{$t('移除主题')}</button>{/if}
    </div>
  </details>
</div>
