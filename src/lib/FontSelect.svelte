<script lang="ts">
  /**
   * 文件职责：提供可搜索、可预览的字体族选择菜单。
   * 定义范围：弹层交互、系统字体懒加载与键盘确认契约；不解析字体栈或访问持久化。
   * 复用说明：沿用 theme-select-* 共享下拉样式与弹层定位契约，仅补充搜索框与逐字体预览。
   */
  import { tick } from 'svelte';
  import { loadSystemFontFamilies, quoteFontFamily } from './font-stack';
  import { t } from './i18n';

  interface FontOption {
    value: string | null;
    label: string;
  }

  interface Props {
    id: string;
    label: string;
    /** 当前族名；allowEmpty 时 null 表示未选择。 */
    value: string | null;
    allowEmpty?: boolean;
    /** 为紧凑设置列表使用左右排列；只改变布局，不改变选项、焦点及确认契约。 */
    inline?: boolean;
  }

  /** 弹层一次渲染的选项上限；超限时继续输入筛选，避免超大字体列表拖慢弹层。 */
  const MAX_RENDERED_OPTIONS = 200;

  let { id, label, value = $bindable(), allowEmpty = false, inline = false }: Props = $props();
  let trigger: HTMLButtonElement;
  let searchInput: HTMLInputElement;
  let popup: HTMLDivElement;
  let open = $state(false);
  let activeIndex = $state(-1);
  let query = $state('');
  let fonts = $state<string[] | null>(null);
  let loading = $state(false);
  let loadFailed = $state(false);
  const popupId = $derived(`${id}-listbox`);

  /**
   * 函数职责：把已加载字体与搜索词合成渲染选项。
   * 输入说明：fonts 为 null 表示尚未加载；query 按大小写不敏感子串过滤。
   * 输出说明：allowEmpty 时首项恒为“无”；超出上限的选项不渲染，由状态行提示继续筛选。
   */
  const visibleOptions = $derived.by<FontOption[]>(() => {
    const keyword = query.trim().toLowerCase();
    const matched = (fonts ?? []).filter((family) => family.toLowerCase().includes(keyword));
    const options: FontOption[] = matched.slice(0, MAX_RENDERED_OPTIONS).map((family) => ({ value: family, label: family }));
    if (allowEmpty) options.unshift({ value: null, label: $t('无') });
    return options;
  });

  /** 函数职责：计算加载与筛选状态行文案；输出说明：null 表示不显示状态行。 */
  const status = $derived.by<string | null>(() => {
    if (loading) return $t('正在加载系统字体…');
    if (loadFailed) return $t('无法读取系统字体，可手动输入字体名。');
    if (fonts === null) return null;
    const keyword = query.trim().toLowerCase();
    const matched = fonts.filter((family) => family.toLowerCase().includes(keyword));
    if (matched.length === 0) return $t('没有匹配的字体');
    if (matched.length > MAX_RENDERED_OPTIONS) {
      return $t('还有 {count} 个字体，请继续输入筛选', { count: matched.length - MAX_RENDERED_OPTIONS });
    }
    return null;
  });

  function positionPopup() {
    if (!open || !trigger || !popup) return;
    const bounds = trigger.getBoundingClientRect();
    // 顶层浮层不受父容器裁切；锚点滚出任一裁切祖先时收起，避免菜单脱离字段悬浮。
    for (let ancestor = trigger.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clip = ancestor.getBoundingClientRect();
      if ((/auto|scroll|hidden|clip/.test(style.overflowY) && (bounds.bottom <= clip.top || bounds.top >= clip.bottom)) ||
          (/auto|scroll|hidden|clip/.test(style.overflowX) && (bounds.right <= clip.left || bounds.left >= clip.right))) {
        close();
        return;
      }
    }
    const margin = 8;
    const gap = 4;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const below = viewportTop + viewportHeight - bounds.bottom - gap - margin;
    const above = bounds.top - viewportTop - gap - margin;
    const desiredHeight = Math.min(popup.scrollHeight, 320);
    const placeAbove = below < desiredHeight && above > below;
    const availableHeight = Math.max(0, placeAbove ? above : below);
    const width = Math.min(bounds.width, Math.max(0, viewportWidth - margin * 2));
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${Math.min(320, availableHeight)}px`;
    popup.style.left = `${Math.max(viewportLeft + margin, Math.min(bounds.left, viewportLeft + viewportWidth - margin - width))}px`;
    popup.style.top = `${placeAbove ? Math.max(viewportTop + margin, bounds.top - gap - popup.getBoundingClientRect().height) : bounds.bottom + gap}px`;
  }

  function close() {
    open = false;
    query = '';
    if (typeof popup?.hidePopover === 'function' && popup.matches(':popover-open')) popup.hidePopover();
  }

  /** 函数职责：首次展开时懒加载字体列表；失败保留状态行并允许重试。 */
  function ensureFonts() {
    if (fonts !== null || loading || loadFailed) return;
    loading = true;
    loadSystemFontFamilies()
      .then((families) => { fonts = families; })
      .catch(() => { loadFailed = true; })
      .finally(() => { loading = false; });
  }

  async function reveal() {
    ensureFonts();
    activeIndex = Math.max(0, visibleOptions.findIndex((option) => option.value === value));
    open = true;
    await tick();
    // 等待 hidden 更新后再进入顶层；异步间隙关闭或卸载时不能重新打开。
    if (!open || !popup?.isConnected) return;
    if (typeof popup.showPopover === 'function' && !popup.matches(':popover-open')) popup.showPopover();
    positionPopup();
    searchInput?.focus();
    scrollActiveIntoView();
  }

  function scrollActiveIntoView() {
    const list = popup?.querySelector('.font-select-options');
    const option = popup?.querySelectorAll('.theme-select-option')[activeIndex] as HTMLElement | undefined;
    if (!option || !list) return;
    // 只滚动选项面板，避免 scrollIntoView 连带移动设置页或外层弹窗。
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    const bottom = option.offsetTop + option.offsetHeight;
    if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }

  function activate(index: number) {
    activeIndex = Math.max(0, Math.min(index, visibleOptions.length - 1));
    void tick().then(scrollActiveIntoView);
  }

  function commit(index: number) {
    const option = visibleOptions[index];
    if (!option) return;
    value = option.value;
    close();
    trigger.focus();
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Tab') {
      close();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) void reveal();
    }
  }

  /** 函数职责：在搜索框内驱动键盘导航；字符输入保持原生光标行为。 */
  function onSearchKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
      return;
    }
    if (event.key === 'Tab') {
      // 焦点自然移动到下一控件，仅收起弹层；不能用 focusout 关闭，
      // 因为点击选项区滚动条会把焦点交给可滚动祖先（Chromium 滚动容器聚焦），误判为离开。
      close();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (visibleOptions.length === 0) return;
      const last = visibleOptions.length - 1;
      if (event.key === 'Home') activate(0);
      else if (event.key === 'End') activate(last);
      else if (event.key === 'ArrowDown') activate(activeIndex >= last ? 0 : activeIndex + 1);
      else activate(activeIndex <= 0 ? last : activeIndex - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(activeIndex);
    }
  }

  // 收起契约不包含 focusout：点击选项区滚动条会把焦点交给可滚动祖先（Chromium 滚动容器聚焦），
  // focusout 会把这次焦点转移误判为离开；弹层外点击由 document 级 pointerdown 捕获兜底，Tab 由搜索框显式收起。
  $effect(() => {
    if (!open) return;
    function onPointerdown(event: PointerEvent) {
      const path = event.composedPath();
      if (!path.includes(trigger) && !path.includes(popup)) close();
    }
    function onScroll(event: Event) {
      if (event.target !== popup) positionPopup();
    }
    document.addEventListener('pointerdown', onPointerdown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', positionPopup);
    window.visualViewport?.addEventListener('resize', positionPopup);
    window.visualViewport?.addEventListener('scroll', positionPopup);
    return () => {
      document.removeEventListener('pointerdown', onPointerdown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', positionPopup);
      window.visualViewport?.removeEventListener('resize', positionPopup);
      window.visualViewport?.removeEventListener('scroll', positionPopup);
      if (typeof popup?.hidePopover === 'function' && popup.matches(':popover-open')) popup.hidePopover();
    };
  });
</script>

<div class="theme-select-field" class:theme-select-inline={inline}>
  <label for={id} id={`${id}-label`}>{label}</label>
  <button
    bind:this={trigger}
    {id}
    type="button"
    class="theme-select-trigger"
    role="combobox"
    aria-labelledby={`${id}-label`}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={popupId}
    aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
    onclick={() => open ? close() : void reveal()}
    onkeydown={onTriggerKeydown}
  >
    <span style:font-family={value ? quoteFontFamily(value) : undefined}>{value ?? $t('未选择')}</span>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </button>
  <div
    bind:this={popup}
    id={popupId}
    class="theme-select-popup dropdown font-select-popup"
    role="dialog"
    aria-labelledby={`${id}-label`}
    popover="manual"
    hidden={!open}
    style="position: fixed; margin: 0; bottom: auto; right: auto; box-sizing: border-box;"
  >
    <input
      bind:this={searchInput}
      bind:value={query}
      class="font-select-search"
      type="text"
      aria-label={$t('搜索字体')}
      aria-controls={popupId}
      placeholder={$t('搜索字体…')}
      oninput={() => activate(Math.max(0, visibleOptions.findIndex((option) => option.value === value)))}
      onkeydown={onSearchKeydown}
    />
    <div class="font-select-options" role="listbox" aria-labelledby={`${id}-label`}>
      {#each visibleOptions as option, index (option.value ?? `${id}-empty`)}
        <button
          id={`${id}-option-${index}`}
          type="button"
          class="theme-select-option"
          role="option"
          tabindex="-1"
          aria-selected={option.value === value}
          data-active={index === activeIndex}
          onpointermove={() => activeIndex = index}
          onpointerdown={(event) => event.preventDefault()}
          onclick={() => commit(index)}
        >
          {#if option.value === null}
            <span class="font-select-sample">{option.label}</span>
          {:else}
            <span class="font-select-sample" style:font-family={quoteFontFamily(option.value)}>{option.label}</span>
          {/if}
          <span class="theme-select-check" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
        </button>
      {/each}
    </div>
    {#if status !== null}
      <p class="font-select-status" role="status">{status}</p>
    {/if}
  </div>
</div>
