<script lang="ts">
  /** 页内单选菜单；导航只改变活动项，确认后才写回绑定值，选项 value 必须唯一。 */
  import { tick } from "svelte";

  interface Option {
    value: string;
    label: string;
  }

  interface Props {
    id: string;
    label: string;
    value: string;
    options: Option[];
    disabled?: boolean;
  }

  let { id, label, value = $bindable(), options, disabled = false }: Props = $props();
  let trigger: HTMLButtonElement;
  let popup: HTMLDivElement;
  let open = $state(false);
  let activeIndex = $state(-1);
  let search = "";
  let searchAt = 0;
  const selected = $derived(options.find((option) => option.value === value));
  const popupId = $derived(`${id}-listbox`);

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
    search = "";
    // manual popover 的顶层状态不随 Svelte 状态自动关闭；卸载前也必须清理。
    if (typeof popup?.hidePopover === "function" && popup.matches(":popover-open")) popup.hidePopover();
  }

  async function reveal(index = options.findIndex((option) => option.value === value)) {
    if (disabled || options.length === 0) return;
    activeIndex = Math.max(0, index);
    open = true;
    await tick();
    // 等待 hidden 更新后再进入顶层；异步间隙关闭或卸载时不能重新打开。
    if (!open || !popup?.isConnected) return;
    if (typeof popup.showPopover === "function" && !popup.matches(":popover-open")) popup.showPopover();
    positionPopup();
    scrollActiveIntoView();
  }

  function scrollActiveIntoView() {
    const option = popup?.children[activeIndex] as HTMLElement | undefined;
    if (!option) return;
    // 只滚动选项面板，避免 scrollIntoView 连带移动设置页或外层弹窗。
    if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop;
    const bottom = option.offsetTop + option.offsetHeight;
    if (bottom > popup.scrollTop + popup.clientHeight) popup.scrollTop = bottom - popup.clientHeight;
  }

  function activate(index: number) {
    activeIndex = Math.max(0, Math.min(index, options.length - 1));
    void tick().then(scrollActiveIntoView);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option || disabled) return;
    value = option.value;
    close();
    trigger.focus();
  }

  function searchOptions(character: string) {
    const now = Date.now();
    search = now - searchAt > 700 ? character : search + character;
    searchAt = now;
    const query = [...search].every((letter) => letter === character) ? character : search;
    const start = query.length === 1 ? activeIndex + 1 : activeIndex;
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (Math.max(0, start) + offset) % options.length;
      if (options[index].label.toLocaleLowerCase().startsWith(query)) {
        activate(index);
        return;
      }
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (disabled || event.isComposing) return;
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const navigation = ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key);
    if (navigation) {
      event.preventDefault();
      if (!open) {
        void reveal(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : undefined);
        return;
      }
      activate(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter" || (event.key === " " && (!search || Date.now() - searchAt > 700))) {
      event.preventDefault();
      if (open) commit(activeIndex);
      else void reveal();
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      if (!open) void reveal();
      searchOptions(event.key.toLocaleLowerCase());
    }
  }

  $effect(() => {
    if (disabled || options.length === 0) close();
  });

  $effect(() => {
    if (!open) return;
    function onPointerdown(event: PointerEvent) {
      const path = event.composedPath();
      if (!path.includes(trigger) && !path.includes(popup)) close();
    }
    function onScroll(event: Event) {
      if (event.target !== popup) positionPopup();
    }
    document.addEventListener("pointerdown", onPointerdown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", positionPopup);
    window.visualViewport?.addEventListener("resize", positionPopup);
    window.visualViewport?.addEventListener("scroll", positionPopup);
    return () => {
      document.removeEventListener("pointerdown", onPointerdown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", positionPopup);
      window.visualViewport?.removeEventListener("resize", positionPopup);
      window.visualViewport?.removeEventListener("scroll", positionPopup);
      if (typeof popup?.hidePopover === "function" && popup.matches(":popover-open")) popup.hidePopover();
    };
  });
</script>

<div class="theme-select-field">
  <label for={id} id={`${id}-label`}>{label}</label>
  <button
    bind:this={trigger}
    {id}
    {value}
    type="button"
    class="theme-select-trigger"
    role="combobox"
    aria-labelledby={`${id}-label`}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={popupId}
    aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
    {disabled}
    onclick={() => open ? close() : void reveal()}
    onkeydown={onKeydown}
    onblur={close}
  >
    <span>{selected?.label ?? value}</span>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </button>
  <div
    bind:this={popup}
    id={popupId}
    class="theme-select-popup dropdown"
    role="listbox"
    aria-labelledby={`${id}-label`}
    popover="manual"
    hidden={!open}
    style="position: fixed; margin: 0; bottom: auto; right: auto; box-sizing: border-box;"
  >
    {#each options as option, index (option.value)}
      <button
        id={`${id}-option-${index}`}
        type="button"
        class="theme-select-option"
        role="option"
        tabindex="-1"
        aria-selected={option.value === value}
        data-active={index === activeIndex}
        data-value={option.value}
        onpointermove={() => activeIndex = index}
        onpointerdown={(event) => event.preventDefault()}
        onclick={() => commit(index)}
      >
        <span>{option.label}</span>
        <span class="theme-select-check" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
      </button>
    {/each}
  </div>
</div>
