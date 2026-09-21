<script lang="ts">
  /** 文件职责：组织项目导航、唯一编辑视图、查询和保存反馈。 */
  import { onMount, tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import appIcon from '../src-tauri/icons/icon.png';
  import WindowControls from './lib/WindowControls.svelte';
  import UpdatePanel from './lib/UpdatePanel.svelte';
  import { UpdateCoordinator } from './lib/updater/update-coordinator';
  import type { UpdateStatus } from './lib/updater/contracts';
  import packageInfo from '../package.json';
  import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
  import { EditorController, getDocumentModel } from './lib/editor';
  import { renderTaskTitle } from './lib/editor/preview';
  import { BrowserFilePort, defaultPreferences, welcomeText } from './lib/browser-files';
  import type { AppConfig, FilePort, FileSnapshot, Project, ProjectView, RecoveryDraft, ViewMode } from './lib/contracts';
  import { SaveCoordinator, errorMessage } from './lib/session/save-coordinator';
  import type { ProjectSession, TaskResult } from './lib/session/types';
  import { archiveSections, parseDocument, searchTasks, taskIsArchived } from './lib/markdown';
  import type { DocumentModel, ListItem } from './lib/markdown';
  import { resolveDocumentResource } from './lib/resource-paths';
  import { validateAppConfig } from './lib/config-validation';
  import { applyTheme, builtInThemes, parseTheme } from './lib/themes';
  import { WindowMaterialController, type WindowMaterial } from './lib/window-material';
  import { createCardWindowController } from './lib/card-window';

  const desktop = isTauri();
  const TOAST_DURATION_MS = 3000;
  const windowMaterial = new WindowMaterialController(document.documentElement, (material, theme) =>
    desktop ? invoke<boolean>('set_window_material', { material, theme: theme === 'system' ? null : theme }) : Promise.resolve(false));
  let files: FilePort;
  let editor: EditorController | undefined;
  let resourceDocumentPath = '';
  let editorHost: HTMLDivElement;
  const sessions = new Map<string, ProjectSession>();
  // 会话必须与 Map、保存闭包共享同一对象；深层代理会让保存器读到代理前的旧 EditorState。
  let active = $state.raw<ProjectSession | null>(null);
  let config = $state<AppConfig>({ projects: [], activeProjectId: null, preferences: { ...defaultPreferences }, projectViews: {} });
  let ready = $state(false);
  let configReady = $state(false);
  let configError = $state('');
  let updater: UpdateCoordinator | undefined;
  let updateStatus = $state<UpdateStatus>({ kind: 'idle' });
  let updateInstalling = $state(false);
  let switching = false;
  let openGeneration = 0;
  let version = $state(0);
  let screen = $state<'project' | 'all'>('project');
  let sidebar = $state(true);
  let reducedMotion = $state(false);
  // 卡片仅改变当前窗口布局，不写入项目配置；原侧栏状态和编辑器实例保留供退出恢复。
  let cardMode = $state(false);
  let cardTransitioning = $state(false);
  let appShell: HTMLDivElement;
  const cardWindow = desktop ? createCardWindowController() : undefined;

  /**
   * 函数职责：切换卡片布局，并在桌面环境同步窗口几何与置顶状态。
   * 输入说明：同一按钮触发；切换未完成时忽略重复请求，鼠标触发后解除按钮焦点。
   * 输出说明：原生操作成功后更新布局，失败保留当前入口并展示错误。
   * 实现思路：先淡出布局，再由窗口控制器切换几何，成功后淡入新布局；减少动态效果时跳过动画。
   */
  async function toggleCardMode(event: MouseEvent): Promise<void> {
    if (cardTransitioning) return;
    cardTransitioning = true;
    const button = event.currentTarget as HTMLButtonElement;
    const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let transition: Animation | undefined;
    try {
      if (animate && appShell.animate) {
        transition = appShell.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: 'ease-out', fill: 'forwards' });
        await transition.finished;
      }
      // 淡出保持到原生几何与新布局均已就绪，避免缩放期间旧侧栏和正文反复重排闪烁。
      if (cardMode) await cardWindow?.exit({ animate });
      else await cardWindow?.enter({ animate });
      cardMode = !cardMode;
      menuOpen = false;
      searchOpen = false;
      await tick();
      transition?.cancel();
      if (animate && appShell.animate) {
        transition = appShell.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
        await transition.finished;
      }
      // 鼠标进入卡片后底栏自动收起；键盘操作保留焦点，便于再次退出。
      if (event.detail > 0) button.blur();
    } catch (error) {
      notify(`卡片模式切换失败：${errorMessage(error)}`);
    } finally {
      // 失败或动画取消也必须解除透明状态，确保重试入口不会留在不可见的窗口中。
      transition?.cancel();
      cardTransitioning = false;
      // 原生调用期间 disabled 可能移走焦点；重新启用后恢复键盘退出入口。
      if (event.detail === 0) {
        await tick();
        button.focus({ preventScroll: true });
      }
    }
  }
  let projectFilter = $state('');
  let projectSearchOpen = $state(false);
  let draggedProjectId = $state<string | null>(null);
  let projectDropTarget = $state<{ id: string; after: boolean } | null>(null);
  let query = $state('');
  let searchOpen = $state(false);
  let includeArchived = $state(false);
  let results = $state<TaskResult[]>([]);
  let resultLimit = $state(100);
  // 每条聚合结果保留生成它的语法快照，异步刷新时标题与引用定义不会跨版本混用。
  type AggregateResult = TaskResult & {
    model: DocumentModel; item: ListItem; path: string;
    /** 最近章节在同一文档中的起点；无章节或系统归档标题为 null，同名用户章节通过位置区分。 */
    sectionFrom: number | null;
  };
  let aggregateResults = $state.raw<AggregateResult[]>([]);
  let aggregateLimits = $state<Record<string, number>>({});
  let indexing = $state(false);
  let indexGeneration = 0;
  const indexCache = new Map<string, { text: string; model: DocumentModel }>();
  let searchTimer: ReturnType<typeof setTimeout>;
  let configTimer: ReturnType<typeof setTimeout>;
  let configQueue: Promise<void> = Promise.resolve();
  let toast = $state('');
  let toastUndo = $state(false);
  let toastTimer: ReturnType<typeof setTimeout>;
  let fatal = $state('');
  let missing = $state<Project | null>(null);
  let menuOpen = $state(false);
  let dialog = $state<'project' | 'rename' | 'settings' | 'help' | 'conflict' | 'recovery' | 'remove' | 'updates' | null>(null);
  let projectName = $state('');
  let projectPath = $state('');
  let createFile = $state(false);
  let dialogError = $state('');
  let systemDark = $state(false);
  let themeImportBusy = $state(false);
  let themeExportBusy = $state(false);
  let themeInput = $state<HTMLInputElement>();
  const themes = $derived([...builtInThemes, ...(config.customThemes ?? [])]);
  const selectedTheme = $derived(themes.find(theme => theme.id === config.preferences.themeId) ?? builtInThemes[0]);
  const resolvedThemeMode = $derived(config.preferences.theme === 'system' ? (systemDark ? 'dark' : 'light') : config.preferences.theme);
  const selectedWindowMaterial = $derived((selectedTheme.monochrome ? 'opaque' :
    selectedTheme.appearance?.[resolvedThemeMode]?.['window-material'] ?? 'opaque') as WindowMaterial);
  let recovery = $state<{ project: Project; disk: FileSnapshot; text: string } | null>(null);
  const visibleProjects = $derived(config.projects.filter(project => project.name.toLocaleLowerCase().includes(projectFilter.toLocaleLowerCase())));
  const mode = $derived.by(() => { void version; return active?.ui.mode ?? 'todo'; });
  const previewMode = $derived.by(() => { void version; return mode === 'source' ? active?.ui.sourceView ?? 'todo' : mode; });
  const saveStatus = $derived.by(() => { void version; return active?.status; });
  // 按正文与磁盘基线比较，避免撤销回原文或仅恢复数据清理失败时误报未保存。
  const hasUnsavedChanges = $derived.by(() => { void version; return active?.saver.hasLocalChanges ?? false; });
  const counts = $derived.by(() => {
    void version;
    if (!active) return { todo: 0, archive: 0 };
    const model = getDocumentModel(active.state);
    const archived = model.tasks.filter(item => taskIsArchived(model, item)).length;
    return { todo: model.tasks.length - archived, archive: archived };
  });

  $effect(() => {
    const p = config.preferences;
    applyTheme(document.documentElement, selectedTheme, p.theme, systemDark);
    document.documentElement.style.setProperty('--document-font', p.fontFamily);
    document.documentElement.style.setProperty('--document-size', `${p.fontSize}px`);
    document.documentElement.style.setProperty('--document-width', `${p.contentWidth}px`);
    if (ready && configReady) scheduleConfig();
  });
  $effect(() => { void query; void includeArchived; if (ready && (searchOpen || screen === 'all')) scheduleIndex(); });
  // 显式明暗同步原生窗口；system 解除原生覆盖，避免 WebView 的媒体查询被上一次显式模式锁住。
  $effect(() => {
    void windowMaterial.update(selectedWindowMaterial, config.preferences.theme).catch(error => { toast = `窗口材质应用失败：${errorMessage(error)}`; });
  });

  /**
   * 开始内部项目拖动；只记录稳定 ID，排序在成功放下时提交。
   * Windows 上依赖窗口配置 dragDropEnabled=false，避免原生文件拖放拦截 HTML 拖放事件。
   */
  function startProjectDrag(event: DragEvent, id: string): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-foldmark-project', id);
    draggedProjectId = id;
    projectDropTarget = null;
  }

  /** 根据目标行中线显示插入位置；外部拖入和自身目标不参与排序。 */
  function previewProjectDrop(event: DragEvent, id: string): void {
    if (!draggedProjectId || draggedProjectId === id) { projectDropTarget = null; return; }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    projectDropTarget = { id, after: event.clientY >= bounds.top + bounds.height / 2 };
  }

  /** 按完整项目数组移动源项，保留隐藏项相对顺序及当前会话，并复用配置保存队列。 */
  function dropProject(event: DragEvent, id: string): void {
    previewProjectDrop(event, id);
    const sourceId = draggedProjectId;
    const target = projectDropTarget;
    draggedProjectId = null; projectDropTarget = null;
    if (!sourceId || !target) return;
    const source = config.projects.find(project => project.id === sourceId);
    if (!source) return;
    // 先移除源项再定位目标，避免向下移动时的索引偏移；筛选只影响显示。
    const reordered = config.projects.filter(project => project.id !== sourceId);
    const targetIndex = reordered.findIndex(project => project.id === target.id);
    if (targetIndex < 0) return;
    reordered.splice(targetIndex + Number(target.after), 0, source);
    if (reordered.every((project, index) => project.id === config.projects[index].id)) return;
    config.projects = reordered;
    scheduleConfig();
  }

  function notify(message: string, undoable = false): void {
    toast = message; toastUndo = undoable; clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = ''; }, TOAST_DURATION_MS);
  }

  /**
   * 函数职责：安装更新前保存全部已打开文档与配置，并禁止继续输入。
   * 输入说明：只由更新协调器在签名验证成功且用户点击安装后调用。
   * 输出说明：全部保存成功返回 true；失败由协调器解除编辑锁并保留安装包。
   * 实现思路：锁定界面、捕获定位、等待所有保存器和配置队列，再允许原生安装退出。
   */
  async function prepareUpdateInstall(): Promise<boolean> {
    updateInstalling = true;
    // 撤销提示位于主界面外；进入保存屏障后不能再从提示条产生新的正文事务。
    toast = ''; toastUndo = false; clearTimeout(toastTimer);
    await tick();
    captureUI(); clearTimeout(configTimer);
    const saved = await Promise.all([...sessions.values()].map(session => session.saver.flush()));
    const configured = await persistConfig();
    return saved.every(Boolean) && configured;
  }

  /** 更新偏好与普通配置走同一持久化队列；禁用自动下载不会打断已经开始的校验。 */
  function updatePreferences(autoCheck: boolean, autoDownload: boolean): void {
    config.preferences.autoCheckUpdates = autoCheck;
    config.preferences.autoDownloadUpdates = autoDownload;
    updater?.setAutoDownload(autoDownload); scheduleConfig();
  }

  /** 校验完整成功后才更新主题列表；重复 ID 必须先移除，避免无提示覆盖用户的配色。 */
  async function importTheme(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || themeImportBusy) return;
    themeImportBusy = true; dialogError = '';
    try {
      if (file.size > 65536) throw new Error('THEME_INVALID: 主题文件不能超过 64 KiB。');
      const theme = parseTheme(await file.text());
      if (themes.some(existing => existing.id === theme.id)) throw new Error('THEME_DUPLICATE: 此主题 ID 已存在，请修改文件中的 id 或先移除已有主题。');
      config.customThemes = [...(config.customThemes ?? []), theme];
      config.preferences.themeId = theme.id;
      await persistConfig();
    } catch (error) { dialogError = errorMessage(error); }
    finally { input.value = ''; themeImportBusy = false; }
  }

  /** 移除只作用于应用保存的主题副本，并回退到内置主题；原始 JSON 文件不变。 */
  function removeTheme(): void {
    config.customThemes = (config.customThemes ?? []).filter(theme => theme.id !== selectedTheme.id);
    config.preferences.themeId = 'paper'; dialogError = '';
  }

  /** 桌面 WebView 不依赖浏览器下载行为，必须经系统对话框与文件端口保存；取消不写入，失败保留错误反馈。 */
  async function exportThemeTemplate(): Promise<void> {
    if (themeExportBusy) return;
    themeExportBusy = true; dialogError = '';
    // 内置 ID 改为可导入的自定义 ID，完整保留两个模式供用户编辑。
    const template = { ...selectedTheme, id: `custom-${selectedTheme.id}`.slice(0, 64), name: `${selectedTheme.name}（自制）`.slice(0, 80) };
    try {
      const text = JSON.stringify(template, null, 2);
      if (desktop) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const path = await save({ title: '保存主题模板', defaultPath: `${template.id}.json`, filters: [{ name: 'JSON 主题', extensions: ['json'] }] });
        if (!path) return;
        await files.create(path, text);
        notify('主题模板已保存');
        return;
      }
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${template.id}.json`;
      document.body.append(anchor);
      try { anchor.click(); }
      finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error) { dialogError = `主题模板保存失败：${errorMessage(error)}`; }
    finally { themeExportBusy = false; }
  }

  /** 配置保存独立排队，保证较旧的界面快照不能覆盖新配置。 */
  function scheduleConfig(): void {
    clearTimeout(configTimer);
    configTimer = setTimeout(() => { void persistConfig(); }, 250);
  }
  async function persistConfig(): Promise<boolean> {
    if (!files || !configReady) return false;
    captureUI();
    const snapshot = JSON.parse(JSON.stringify(config)) as AppConfig;
    configQueue = configQueue.catch(() => {}).then(() => files.saveConfig(snapshot));
    try { await configQueue; configError = ''; return true; }
    catch (error) { configError = `配置保存失败：${errorMessage(error)}`; notify(configError); return false; }
  }
  function captureUI(): void {
    if (!active || !editor || switching) return;
    active.state = editor.state; active.ui = editor.getUIState();
    config.projectViews[active.project.id] = active.ui;
  }
  function documentChanged(): void {
    if (switching || !active || !editor) return;
    active.state = editor.state; active.ui = editor.getUIState();
    active.saver.changed(); version += 1;
    if (searchOpen || screen === 'all') scheduleIndex();
  }
  function freshUI(project: Project): ProjectView {
    return config.projectViews[project.id] ?? { mode: 'todo', cursor: 0, scrollTop: 0, folded: [] };
  }

  /**
   * 异步读文件使用代次检查，快速切换时较早的读取不能抢回当前项目。
   * 归档整理必须在当前会话与保存器就绪后执行；查询坐标属于整理前快照，须先定位再让事务映射选区。
   */
  async function openProject(project: Project, position?: number, targetMode?: ViewMode): Promise<void> {
    const generation = ++openGeneration;
    captureUI(); screen = 'project'; missing = null; fatal = ''; menuOpen = false; toast = '';
    try {
      let session = sessions.get(project.id);
      if (!session) {
        const disk = await files.read(project.path);
        let draft: RecoveryDraft | null = null;
        let recoveryWarning = '';
        try { draft = await files.loadRecovery(project.path); }
        catch (error) { recoveryWarning = `恢复草稿无法读取：${errorMessage(error)}`; }
        if (generation !== openGeneration) return;
        const ui = freshUI(project);
        resourceDocumentPath = project.path;
        switching = true;
        if (!editor) editor = new EditorController(editorHost, {
          text: disk.text, mode: ui.mode, onChange: documentChanged,
          onStatus: message => notify(message, message.includes('可撤销')),
          resolveResource: url => desktop ? resolveDocumentResource(resourceDocumentPath, url, convertFileSrc) : url,
          openLink: openDocumentLink,
        });
        else editor.restoreState(editor.createState(disk.text, ui.mode));
        editor.setUIState(ui);
        const current: ProjectSession = {
          project, state: editor.state, ui, recoveryWarning, stopWatch: () => {}, status: { kind: 'saved', message: '所有更改已保存' },
          saver: undefined as unknown as SaveCoordinator,
        };
        current.saver = new SaveCoordinator({
          files, snapshot: disk, getText: () => current.state.doc.toString(), preserveRecovery: !!recoveryWarning || !!draft && draft.text !== disk.text,
          reload: (text, reason) => {
            if (active?.project.id === project.id && editor) {
              switching = true; editor.setText(text, true); current.state = editor.state; switching = false;
              if (reason === 'external' && !current.saver.hasProtectedRecovery) editor.normalizeArchive();
            } else if (editor) current.state = editor.createState(text, current.ui.mode);
            version += 1; scheduleIndex();
          },
          onStatus: status => { current.status = status; version += 1; },
        });
        sessions.set(project.id, current); session = current;
        void files.watch(project.path, () => { void current.saver.checkExternal(); indexCache.delete(project.id); })
          .then(stop => { if (sessions.has(project.id)) current.stopWatch = stop; else stop(); })
          .catch(error => notify(`文件监听暂不可用：${errorMessage(error)}`));
        if (draft && draft.text !== disk.text) { recovery = { project, disk, text: draft.text }; dialog = 'recovery'; }
      }
      if (generation !== openGeneration) { switching = false; return; }
      switching = true; active = session; config.activeProjectId = project.id;
      resourceDocumentPath = project.path;
      editor!.restoreState(session.state, targetMode ? { ...session.ui, mode: targetMode } : session.ui); switching = false;
      version += 1; scheduleConfig();
      if (position !== undefined) { searchOpen = false; await tick(); editor!.focusAt(position); }
      else editor!.view.focus();
      if (!session.saver.hasProtectedRecovery) editor!.normalizeArchive();
      // 仅切换模式或定位不会触发正文回调，仍须同步会话，供标签状态和下次恢复使用。
      captureUI(); version += 1;
    } catch (error) {
      if (generation !== openGeneration) return;
      switching = false; fatal = errorMessage(error); missing = project;
    }
  }

  function setMode(next: ViewMode): void {
    if (!active || !editor) return;
    editor.setMode(next, !active.saver.hasProtectedRecovery); captureUI(); version += 1; scheduleConfig();
  }
  /** 切换当前分区的源码与预览；定位恢复由编辑器负责，应用只同步持久化界面状态。 */
  function toggleSource(): void {
    if (!active || !editor) return;
    editor.toggleSource(!active.saver.hasProtectedRecovery);
    captureUI(); version += 1; scheduleConfig();
  }
  async function showAll(): Promise<void> { captureUI(); screen = 'all'; query = ''; searchOpen = false; toast = ''; await updateIndex(); }
  /** Svelte 只管理挂载点；内容由正文共享渲染器生成，更新时整体替换只读 DOM。 */
  function taskTitle(node: HTMLElement, result: AggregateResult): { update: (next: AggregateResult) => void } {
    const update = (next: AggregateResult): void => {
      node.replaceChildren(renderTaskTitle(next.model, next.item, {
        resolveResource: url => resolveDocumentResource(next.path, url, path => desktop ? convertFileSrc(path) : path),
      }));
    };
    update(result);
    return { update };
  }
  function scheduleIndex(): void { clearTimeout(searchTimer); searchTimer = setTimeout(() => { void updateIndex(); }, 350); }
  /** 查询缓存只持有不可编辑语法投影；正文变化才重建，保存反馈不触发重复解析。 */
  function modelForProject(projectId: string, text: string): DocumentModel {
    const session = sessions.get(projectId);
    if (session) return getDocumentModel(session.state);
    const previous = indexCache.get(projectId);
    if (previous?.text === text) return previous.model;
    const model = parseDocument(text); indexCache.set(projectId, { text, model }); return model;
  }
  async function updateIndex(): Promise<void> {
    const generation = ++indexGeneration; indexing = true;
    const found: TaskResult[] = [];
    const allFound: AggregateResult[] = [];
    for (const project of config.projects) {
      if (generation !== indexGeneration) return;
      try {
        const text = sessions.get(project.id)?.state.doc.toString() ?? (await files.read(project.path)).text;
        const model = modelForProject(project.id, text);
        for (const result of searchTasks(model, query, searchOpen && includeArchived)) {
          found.push({ projectId: project.id, projectName: project.name, from: result.from, title: result.title, section: result.heading, checked: result.archived });
        }
        if (screen === 'all') {
          let headingIndex = -1;
          const archiveHeadingStarts = new Set(archiveSections(model).map(section => section.from));
          // 任务与章节均按原文位置排序，单次推进游标保留同名章节身份，避免逐任务扫描整篇文档。
          for (const result of searchTasks(model, '', false)) {
            while (headingIndex + 1 < model.headings.length && model.headings[headingIndex + 1].from < result.from) headingIndex++;
            const heading = model.headings[headingIndex];
            // 一级归档标题只表示文件存储分区，不作为待办分组；归档内用户创建的子标题仍保留。
            const sectionFrom = heading && !archiveHeadingStarts.has(heading.from) ? heading.from : null;
            allFound.push({ projectId: project.id, projectName: project.name, from: result.from, title: result.title, section: sectionFrom === null ? '' : result.heading, sectionFrom, checked: false, model, item: result.item, path: project.path });
          }
        }
      } catch { /* 失效路径由项目打开流程提供重新定位，不阻止其他项目查询。 */ }
      // 每个项目之间让出事件循环，索引不同时创建多个编辑器。
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (generation === indexGeneration) { results = found; resultLimit = 100; aggregateResults = allFound; indexing = false; }
  }
  async function locate(result: TaskResult): Promise<void> {
    const project = config.projects.find(item => item.id === result.projectId);
    if (project) {
      await openProject(project, result.from, result.checked ? 'archive' : 'todo');
    }
  }

  function openDialog(next: typeof dialog): void {
    menuOpen = false; dialogError = ''; dialog = next;
    if (next === 'project') { projectName = ''; projectPath = ''; createFile = false; }
    if (next === 'rename') projectName = active?.project.name ?? '';
  }
  /** 对话框将键盘焦点限制在当前操作内，关闭时恢复触发控件。 */
  function modalFocus(node: HTMLElement) {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [tabindex="0"]')];
    (node.querySelector<HTMLElement>('input, select, textarea') ?? focusable()[0] ?? node).focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable(); const first = elements[0]; const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    node.addEventListener('keydown', trap);
    return { destroy() { node.removeEventListener('keydown', trap); previous?.focus(); } };
  }
  async function choosePath(create: boolean): Promise<void> {
    try {
      const path = await files.chooseFile(create);
      if (path) { projectPath = path; createFile = create; if (!projectName) projectName = path.split(/[\\/]/).pop()?.replace(/\.(md|markdown|txt)$/i, '') ?? '新项目'; }
    } catch (error) { dialogError = errorMessage(error); }
  }
  async function addProject(): Promise<void> {
    if (!projectName.trim() || !projectPath) { dialogError = '填写项目名称并选择 Markdown 文件。'; return; }
    try {
      if (config.projects.some(item => item.path.replace(/\\/g, '/').toLocaleLowerCase() === projectPath.replace(/\\/g, '/').toLocaleLowerCase())) throw new Error('这个文件已经关联到项目。');
      if (createFile) await files.create(projectPath, `# ${projectName.trim()}\n\n- [ ] \n`);
      else await files.read(projectPath);
      const project = { id: crypto.randomUUID(), name: projectName.trim(), path: projectPath };
      config.projects = [...config.projects, project]; dialog = null; await openProject(project); scheduleConfig(); scheduleIndex();
    } catch (error) { dialogError = errorMessage(error); }
  }
  function renameProject(): void {
    if (!active || !projectName.trim()) return;
    const project = config.projects.find(item => item.id === active!.project.id)!;
    project.name = projectName.trim(); active.project = project; version += 1; dialog = null; scheduleConfig();
  }
  async function removeProject(): Promise<void> {
    if (!active) return;
    const session = active;
    if (!await session.saver.flush()) { dialogError = '仍有未保存内容，请先处理保存失败或冲突，再移除关联。'; return; }
    session.stopWatch(); session.saver.dispose();
    sessions.delete(session.project.id); config.projects = config.projects.filter(item => item.id !== session.project.id);
    delete config.projectViews[session.project.id]; active = null; config.activeProjectId = null; dialog = null;
    if (config.projects[0]) await openProject(config.projects[0]);
    else { editor?.destroy(); editor = undefined; }
    scheduleConfig(); scheduleIndex();
  }
  async function relocate(): Promise<void> {
    const project = missing ?? active?.project;
    if (!project) return;
    try {
      const path = await files.chooseFile(false); if (!path) return;
      if (config.projects.some(item => item.id !== project.id && item.path.replace(/\\/g, '/').toLocaleLowerCase() === path.replace(/\\/g, '/').toLocaleLowerCase())) throw new Error('这个文件已经关联到另一个项目。');
      const disk = await files.read(path);
      const session = sessions.get(project.id);
      // 新文件与内存草稿可能不同；先持久化待恢复文本，打开后展示双方内容供选择。
      if (session?.saver.hasLocalChanges && session.state.doc.toString() !== disk.text) {
        await files.saveRecovery({ path, text: session.state.doc.toString(), baseRevision: disk.revision, savedAt: Date.now() });
      }
      session?.stopWatch(); session?.saver.dispose(); sessions.delete(project.id); project.path = path;
      await openProject(project); scheduleConfig();
    } catch (error) { fatal = errorMessage(error); }
  }
  async function save(): Promise<void> { if (active) { captureUI(); if (await active.saver.flush()) notify('已保存'); } }
  async function exportMarkdown(text = active?.state.doc.toString() ?? '', name = `${active?.project.name ?? '清单'}.md`): Promise<void> {
    if (desktop) {
      try { const path = await files.chooseFile(true); if (path) { await files.create(path, text); notify('副本已保存'); } }
      catch (error) { notify(errorMessage(error)); }
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
  }
  async function resolveConflict(keepLocal: boolean): Promise<void> {
    const external = active?.status.external; if (!active || !external) return;
    try {
      if (keepLocal) await active.saver.keepLocal(external);
      else await active.saver.acceptExternal(external);
      dialog = null;
    } catch (error) { dialogError = errorMessage(error); }
  }
  async function recoverDraft(): Promise<void> {
    if (!recovery || !active || !editor) return;
    if (recovery.project.id !== active.project.id) { dialogError = '请先切换到草稿所属项目再恢复。'; return; }
    editor.setText(recovery.text); active.state = editor.state;
    // 恢复操作来自已展示双方全文的对话框，表示采用草稿作为当前编辑内容。
    active.saver.changed(); dialog = null; recovery = null; version += 1;
    editor.normalizeArchive();
  }
  function currentItemAction(action: 'fold' | 'up' | 'down' | 'group'): void {
    if (!editor || screen !== 'project') return;
    const position = editor.state.selection.main.head;
    const item = parseDocument(editor.text).items.filter(item => item.from <= position && item.to >= position).at(-1);
    if (!item) { notify('请先将光标放在列表项中'); return; }
    if (action === 'fold') editor.toggleFold(item.from);
    else if (action === 'group') editor.toggleTask(item.from, true);
    else editor.moveItem(item.from, action);
    menuOpen = false;
  }
  async function openDocumentLink(url: string): Promise<void> {
    try {
      if (url.startsWith('#') && editor) {
        const slug = decodeURIComponent(url.slice(1)).toLocaleLowerCase();
        const heading = editor.model.headings.find(item => item.text.toLocaleLowerCase().replace(/\s+/g, '-') === slug);
        if (heading) editor.focusAt(heading.from);
        else notify('未找到链接对应的章节');
        return;
      }
      if (desktop) {
        const platform = await import('./lib/files/tauri');
        if (/^(https?:|mailto:)/i.test(url) || url.startsWith('//')) { await platform.openExternalLink(url.startsWith('//') ? `https:${url}` : url); return; }
        const path = resolveDocumentResource(resourceDocumentPath, url, path => path);
        const project = config.projects.find(item => item.path.replace(/\\/g, '/').toLocaleLowerCase() === path.toLocaleLowerCase());
        if (project) {
          await openProject(project);
          const hash = url.indexOf('#'); if (hash >= 0) await openDocumentLink(url.slice(hash));
        } else await platform.openLocalDocument(path);
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) { notify(errorMessage(error)); }
  }
  function closeProjectSearch(): void {
    projectSearchOpen = false;
    projectFilter = '';
  }

  function openProjectSearch(): void {
    sidebar = true;
    projectSearchOpen = true;
    searchOpen = false;
    void tick().then(() => document.getElementById('project-filter')?.focus());
  }

  /** 点击冒泡到窗口后再收起，确保菜单命令、项目选择和搜索结果定位先完成；触发按钮也属于弹窗内部。 */
  function dismissPopovers(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('[data-project-search]')) closeProjectSearch();
    if (!target.closest('[data-global-search]')) searchOpen = false;
    if (!target.closest('[data-more-menu]')) menuOpen = false;
  }

  function keydown(event: KeyboardEvent): void {
    if (updateInstalling) { event.preventDefault(); return; }
    if (event.isComposing) return;
    if (event.key === 'Escape') { dialog = null; searchOpen = false; closeProjectSearch(); menuOpen = false; return; }
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
    if (event.key.toLowerCase() === 'p') { event.preventDefault(); openProjectSearch(); }
    if (event.key.toLowerCase() === 'f' && event.shiftKey) { event.preventDefault(); closeProjectSearch(); searchOpen = true; scheduleIndex(); void tick().then(() => document.getElementById('global-search')?.focus()); }
  }

  onMount(() => {
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotionPreference = () => { reducedMotion = motionPreference.matches; };
    updateMotionPreference(); motionPreference.addEventListener('change', updateMotionPreference);
    const colorPreference = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystemTheme = () => { systemDark = colorPreference.matches; };
    updateSystemTheme(); colorPreference.addEventListener('change', updateSystemTheme);
    let unlistenClose = () => {};
    let disposed = false;
    const initialize = async () => {
      try {
        files = desktop ? new (await import('./lib/files/tauri')).TauriFilePort() : new BrowserFilePort();
        const loaded = validateAppConfig(await files.loadConfig());
        if (loaded) config = { ...loaded, preferences: { ...defaultPreferences, ...loaded.preferences }, projectViews: loaded.projectViews ?? {} };
        else if (!desktop) {
          const path = '浏览器/开始.md';
          try { await files.create(path, welcomeText); } catch { /* 重新初始化配置时复用已有预览文件。 */ }
          config.projects = [{ id: 'welcome', name: '开始', path }]; config.activeProjectId = 'welcome';
        }
        if (disposed) return; configReady = true; ready = true;
        const project = config.projects.find(item => item.id === config.activeProjectId) ?? config.projects[0];
        if (project) await openProject(project);
        if (desktop) {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          unlistenClose = await getCurrentWindow().onCloseRequested(async event => {
            event.preventDefault();
            if (updateInstalling) return;
            captureUI();
            const saved = await Promise.all([...sessions.values()].map(session => session.saver.flush()));
            const configured = await persistConfig();
            // 关闭保存可能早于安装请求开始；安装已接管退出时，旧关闭请求不能销毁窗口。
            if (updateInstalling) return;
            if (saved.every(Boolean) && configured) await getCurrentWindow().destroy();
            else notify('仍有正文或配置未保存，请处理保存失败后关闭。');
          });
          // 更新初始化独立于正文加载；检查失败只进入更新面板，不使编辑器变为不可用。
          const { TauriUpdatePort } = await import('./lib/updater/tauri');
          if (disposed) return;
          updater = new UpdateCoordinator({
            port: new TauriUpdatePort(), autoDownload: config.preferences.autoDownloadUpdates ?? true,
            beforeInstall: prepareUpdateInstall, afterInstallFailure: () => { updateInstalling = false; },
            onStatus: status => {
              updateStatus = status;
              if (status.kind === 'ready') notify(`Foldmark ${status.version} 已下载，可在更新面板安装。`);
            },
          });
          if (config.preferences.autoCheckUpdates ?? true) void updater.check();
        }
      } catch (error) { fatal = errorMessage(error); ready = true; }
    };
    void initialize();
    const beforeUnload = () => { captureUI(); void persistConfig(); for (const session of sessions.values()) void session.saver.flush(); };
    const focus = () => { for (const session of sessions.values()) void session.saver.checkExternal(); };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('focus', focus);
    return () => {
      motionPreference.removeEventListener('change', updateMotionPreference);
      colorPreference.removeEventListener('change', updateSystemTheme);
      disposed = true; unlistenClose(); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('focus', focus);
      clearTimeout(searchTimer); clearTimeout(configTimer); clearTimeout(toastTimer);
      updater?.dispose();
      for (const session of sessions.values()) { session.stopWatch(); session.saver.dispose(); } editor?.destroy();
    };
  });
</script>

<svelte:window onkeydown={keydown} onclick={dismissPopovers} />

<div class="app-shell" bind:this={appShell} class:sidebar-hidden={!sidebar || cardMode} class:card-mode={cardMode} class:card-transitioning={cardTransitioning} class:desktop-window={desktop} class:modal-open={dialog !== null} inert={updateInstalling || cardTransitioning}>

  {#if sidebar && !cardMode}
    <!-- 固定侧栏内容宽度，由外层裁切随网格收放，避免动画期间文字和按钮反复换行。 -->
    <div class="sidebar-slot">
    <aside class="sidebar" aria-label="项目导航" inert={!sidebar || cardMode} transition:fly={{ x: -16, duration: reducedMotion || cardTransitioning ? 0 : 180, easing: cubicOut }}>
      <div class="brand" data-tauri-drag-region={desktop ? true : undefined}><img src={appIcon} width="32" height="32" alt="" draggable={false} /><span>Foldmark</span><button class="icon-button sidebar-close" onclick={() => sidebar = false} aria-label="收起项目导航"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13 4-6 6 6 6"/></svg></button></div>
      <button class:nav-active={screen === 'all'} class="nav-item all-nav" onclick={showAll}><span aria-hidden="true">▤</span> 全部待办 <span class="shortcut">⌘</span></button>
      <div class="sidebar-section"><span>项目</span><div class="project-actions">
        <div class="project-search" data-project-search>
          <button class="icon-button" aria-label="查找项目" title="查找项目 (Ctrl P)" aria-expanded={projectSearchOpen} aria-controls="project-search-panel" onclick={() => projectSearchOpen ? closeProjectSearch() : openProjectSearch()}><svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m12 12 5 5" stroke="currentColor" stroke-width="1.7"/></svg></button>
        </div>
        <button class="icon-button" aria-label="新增项目" onclick={() => openDialog('project')}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M10 3v14M3 10h14"/></svg></button>
      </div></div>
      {#if projectSearchOpen}<div id="project-search-panel" class="project-search-panel" data-project-search><input id="project-filter" class="project-filter" aria-label="快速查找项目" placeholder="查找项目…" bind:value={projectFilter} /></div>{/if}
      <nav class="project-list">
        {#each visibleProjects as project (project.id)}
          <button class="nav-item" class:nav-active={screen === 'project' && active?.project.id === project.id}
            class:project-dragging={draggedProjectId === project.id}
            class:project-drop-before={projectDropTarget?.id === project.id && !projectDropTarget.after}
            class:project-drop-after={projectDropTarget?.id === project.id && projectDropTarget.after}
            draggable="true" ondragstart={event => startProjectDrag(event, project.id)}
            ondragover={event => previewProjectDrop(event, project.id)} ondrop={event => dropProject(event, project.id)}
            ondragleave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) projectDropTarget = null; }}
            ondragend={() => { draggedProjectId = null; projectDropTarget = null; }}
            onclick={() => openProject(project)} title={project.path}><span class="project-name">{project.name}</span></button>
        {/each}
      </nav>
      <div class="sidebar-bottom"><button class="icon-button" aria-label="设置" onclick={() => openDialog('settings')}>⚙</button></div>
    </aside>
    </div>
  {/if}

  <main class="main-pane">
    {#if cardMode}
      <!-- 拖动区独占顶部留白，不覆盖编辑器；正文滚动后仍可选中文字。 -->
      <div class="card-drag-region" data-tauri-drag-region={desktop ? true : undefined} aria-hidden="true"></div>
    {/if}
    <!-- 拖动仅命中顶部非交互区域；按钮保留点击行为，Tauri 处理拖动和双击最大化。 -->
    {#if !cardMode}
    <header class="topbar" data-tauri-drag-region={desktop ? true : undefined}>
      <div class="breadcrumb" data-tauri-drag-region={desktop ? true : undefined}>{#if !sidebar}<button class="icon-button" aria-label="展开项目导航" onclick={() => sidebar = true}><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M5 6h10M5 10h10M5 14h10"/></svg></button>{/if}<span class="crumb-label">工作空间</span><span class="crumb-divider">/</span><strong>{screen === 'all' ? '全部待办' : active?.project.name ?? '欢迎'}</strong>{#if screen === 'project' && hasUnsavedChanges}<span class="unsaved-mark" role="status" aria-label="未保存" title="未保存">*</span>{/if}</div>
      <div class="top-actions"><button class="search-button" data-global-search aria-expanded={searchOpen} onclick={() => { searchOpen = !searchOpen; scheduleIndex(); void tick().then(() => document.getElementById('global-search')?.focus()); }}><svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m12 12 5 5" stroke="currentColor" stroke-width="1.7"/></svg>搜索<span class="key-hint">Ctrl ⇧ F</span></button><button class="icon-button" data-more-menu aria-label="更多操作" aria-expanded={menuOpen} onclick={() => menuOpen = !menuOpen}>···</button>{#if desktop}<WindowControls onerror={notify} />{/if}</div>
      {#if menuOpen}<div class="dropdown" data-more-menu role="menu">
        {#if screen === 'project' && active}
        <button role="menuitem" onclick={save}>保存 <kbd>Ctrl S</kbd></button>
        <button role="menuitem" onclick={() => { editor?.insertTask(); menuOpen = false; }}>新增任务</button>
        <button role="menuitem" onclick={() => currentItemAction('group')}>完成整组任务</button>
        <button role="menuitem" onclick={() => currentItemAction('fold')}>折叠 / 展开当前项</button>
        <button role="menuitem" onclick={() => currentItemAction('up')}>同级上移</button>
        <button role="menuitem" onclick={() => currentItemAction('down')}>同级下移</button>
        <hr/><button role="menuitem" onclick={() => openDialog('rename')}>重命名项目</button>
        <button role="menuitem" onclick={() => exportMarkdown()}>另存 Markdown 副本</button>
        <button role="menuitem" onclick={() => openDialog('remove')}>移除项目关联</button>
        <hr/>{/if}<button role="menuitem" onclick={() => openDialog('project')}>新增项目</button><button role="menuitem" onclick={() => openDialog('settings')}>阅读与外观</button><button role="menuitem" onclick={() => openDialog('updates')}>检查更新</button><button role="menuitem" onclick={() => openDialog('help')}>快捷键与使用帮助</button>
      </div>{/if}
    </header>
    {/if}

    {#if searchOpen}
      <section class="search-panel" data-global-search aria-label="跨项目搜索">
        <div class="search-row"><input id="global-search" aria-label="搜索所有项目" placeholder="搜索任务和正文…" bind:value={query} /><button class="icon-button" aria-label="关闭搜索" onclick={() => searchOpen = false}>×</button></div>
        <label class="check-label"><input type="checkbox" bind:checked={includeArchived}/> 包含归档</label>
        <div class="search-results">{#each results.slice(0, resultLimit) as result}<button class="search-result" onclick={() => locate(result)}><span>{result.checked ? '已完成' : '待办'} · {result.title}</span><small>{result.projectName}{result.section ? ` / ${result.section}` : ''}</small></button>{:else}<p class="muted">{indexing ? '正在搜索…' : '没有匹配的任务'}</p>{/each}{#if resultLimit < results.length}<button class="load-more" onclick={() => resultLimit += 100}>显示更多（还有 {results.length - resultLimit} 条）</button>{/if}</div>
      </section>
    {/if}

    {#if screen === 'project' && !cardMode}
      <div class="viewbar"><div class="tabs" aria-label="文档视图">{#each [['todo','待办',counts.todo],['archive','归档',counts.archive]] as tab}<button class:tab-active={previewMode === tab[0]} onclick={() => setMode(tab[0] as ViewMode)}>{tab[1]}{#if tab[2] !== null}<span>{tab[2]}</span>{/if}</button>{/each}</div></div>
    {/if}

    {#if fatal}<div class="error-banner" role="alert">{fatal}{#if missing}<button onclick={relocate}>重新定位文件</button>{/if}</div>{/if}
    {#if configError}<div class="error-banner" role="alert">{configError}<button onclick={() => persistConfig()}>重试配置保存</button></div>{/if}
    {#if active?.recoveryWarning}<div class="error-banner" role="alert">{active.recoveryWarning}。当前显示完好的 Markdown 原文件。</div>{/if}
    {#if saveStatus?.kind === 'conflict'}<div class="conflict-banner" role="status">磁盘文件有新的修改，你的编辑已保留。<button onclick={() => openDialog('conflict')}>比较并处理</button></div>{/if}
    {#if saveStatus?.kind === 'error'}<div class="error-banner" role="alert">保存失败：{saveStatus.message}<button onclick={save}>重试保存</button><button onclick={() => exportMarkdown()}>另存副本</button><button onclick={relocate}>重新定位文件</button></div>{/if}

    <div class="editor-region" class:offscreen={screen !== 'project' || !active || !!missing} bind:this={editorHost}></div>
    {#if !active && screen === 'project' && !fatal}
      <section class="empty-state"><div class="empty-mark">F<span>↳</span></div><p class="eyebrow">为想法留白</p><h1>从一份清单开始。</h1><p>写下要做的事，完成后收进归档。<br/>你的 Markdown 文件，始终由你掌握。</p><button class="primary" onclick={() => openDialog('project')} disabled={!ready}>关联或新建项目</button><button class="text-button" onclick={() => openDialog('help')}>了解编辑方式 →</button></section>
    {/if}
    {#if screen === 'all'}
      <section class="aggregate"><p class="eyebrow">工作空间</p><h1>全部待办<span>{aggregateResults.length}</span></h1><p class="muted">每件事都有自己的位置。选择一项，回到原文继续。</p>
        {#each config.projects as project}
          {@const projectResults = aggregateResults.filter(result => result.projectId === project.id)}
          {#if projectResults.length}
            <section class="aggregate-group">
              <h2>{project.name}<span>{projectResults.length}</span></h2>
              {#each projectResults.slice(0, aggregateLimits[project.id] ?? 100) as result, index}
                {#if result.sectionFrom !== null && (index === 0 || result.sectionFrom !== projectResults[index - 1].sectionFrom)}
                  <h3 class="aggregate-section-heading"><span>{result.section}</span></h3>
                {/if}
                <button class="aggregate-task" class:aggregate-section-task={result.sectionFrom !== null} onclick={() => locate(result)}><span class="readonly-box" aria-hidden="true"></span><span class="aggregate-content"><span class="aggregate-title" use:taskTitle={result}></span></span><span class="result-arrow">↗</span></button>
              {/each}
              {#if projectResults.length > (aggregateLimits[project.id] ?? 100)}<button class="load-more" onclick={() => aggregateLimits[project.id] = (aggregateLimits[project.id] ?? 100) + 100}>显示更多（还有 {projectResults.length - (aggregateLimits[project.id] ?? 100)} 条）</button>{/if}
            </section>
          {/if}
        {/each}
        {#if !aggregateResults.length}<p class="all-clear">{indexing ? '正在读取项目…' : '暂时没有待办。给自己留一点空闲。'}</p>{/if}
      </section>
    {/if}
    <div class="statusbar-dock">
      <footer class="statusbar" data-tauri-drag-region={desktop && cardMode ? true : undefined}>
        <div class="statusbar-actions">
          <button class="source-button" class:source-active={screen === 'project' && mode === 'source'} aria-label={mode === 'source' ? '返回预览' : '查看源码'} title={mode === 'source' ? '返回预览' : '查看源码'} aria-pressed={screen === 'project' && mode === 'source'} disabled={screen !== 'project' || !active} onclick={toggleSource}>&lt;/&gt;</button>
          <button class="card-button" aria-label={cardMode ? '退出卡片模式' : '进入卡片模式'} title={cardMode ? '退出卡片模式' : '进入卡片模式'} aria-pressed={cardMode} disabled={cardTransitioning} onclick={toggleCardMode}><svg width="17" height="19" viewBox="0 0 20 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="2.5" width="13" height="19" rx="2"/><path d="M7 7h6M7 11h6M7 15h3"/></svg></button>
        </div>
        {#if desktop && ['available', 'ready', 'downloading'].includes(updateStatus.kind)}<button onclick={() => openDialog('updates')}>{updateStatus.kind === 'ready' ? '更新已就绪' : updateStatus.kind === 'downloading' ? '正在下载更新…' : '发现新版本'}</button>{/if}<button onclick={() => openDialog('help')}>Markdown <span>·</span> KaTeX</button>
      </footer>
    </div>
  </main>
</div>

{#if toast}<div class="toast" role="status" inert={updateInstalling}><span>{toast}</span>{#if toastUndo}<button onclick={() => { if (!updateInstalling) { editor?.undo(); toast = ''; } }}>撤销</button>{/if}<button aria-label="关闭提示" onclick={() => toast = ''}>×</button></div>{/if}

{#if dialog}
  <div class="modal-backdrop" role="presentation">
    <div class="modal" class:wide={dialog === 'conflict' || dialog === 'recovery'} role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1" use:modalFocus>
      <button class="modal-close icon-button" aria-label="关闭对话框" disabled={updateInstalling} onclick={() => dialog = null}>×</button>
      {#if dialog === 'project'}
        <p class="eyebrow">项目</p><h2 id="dialog-title">给一份清单一个位置</h2><p class="muted">关联已有 Markdown，或选择位置新建文件。</p>
        <label>项目名称<input placeholder="例如：工作、阅读、生活" bind:value={projectName}/></label>
        <div class="file-buttons"><button onclick={() => choosePath(false)}>选择已有文件</button><button onclick={() => choosePath(true)}>新建清单文件</button></div>
        {#if projectPath}<p class="file-path">{projectPath}</p>{/if}
        {#if !desktop}<p class="small muted">浏览器模式会导入文件副本。桌面应用直接关联本地原文件。</p>{/if}
        <button class="primary" onclick={addProject}>添加项目</button>
      {:else if dialog === 'rename'}
        <h2 id="dialog-title">重命名项目</h2><label>项目名称<input bind:value={projectName}/></label><button class="primary" onclick={renameProject}>保存名称</button>
      {:else if dialog === 'remove'}
        <h2 id="dialog-title">移除「{active?.project.name}」的关联？</h2><p>Markdown 文件会保留在原位置。你可以随时重新关联。</p><div class="modal-actions"><button onclick={() => dialog = null}>取消</button><button class="primary" onclick={removeProject}>移除关联</button></div>
      {:else if dialog === 'settings'}
        <p class="eyebrow">阅读与外观</p><h2 id="dialog-title">让文字读起来更舒适</h2>
        <label>主题<select bind:value={config.preferences.themeId}>{#each themes as theme (theme.id)}<option value={theme.id}>{theme.name}</option>{/each}</select></label>
        <label>明暗模式<select bind:value={config.preferences.theme}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
        <input class="offscreen" type="file" accept=".json,application/json" aria-label="导入主题文件" bind:this={themeInput} onchange={importTheme}/>
        <div class="file-buttons"><button disabled={themeImportBusy || !configReady} onclick={() => themeInput?.click()}>{themeImportBusy ? '正在导入…' : '导入主题'}</button><button disabled={themeExportBusy || !configReady} onclick={exportThemeTemplate}>下载主题模板</button>{#if config.customThemes?.some(theme => theme.id === selectedTheme.id)}<button onclick={removeTheme}>移除主题</button>{/if}</div>
        <label>正文字体<input bind:value={config.preferences.fontFamily}/></label>
        <label>字号 <span>{config.preferences.fontSize} px</span><input type="range" min="13" max="24" step="1" bind:value={config.preferences.fontSize}/></label>
        <label>正文宽度 <span>{config.preferences.contentWidth} px</span><input type="range" min="640" max="960" step="20" bind:value={config.preferences.contentWidth}/></label>
        <p class="small muted">外观自动保存。动画遵循系统的减少动态效果设置。</p>
      {:else if dialog === 'updates'}
        <h2 id="dialog-title">应用更新</h2>
        <UpdatePanel {desktop} currentVersion={packageInfo.version} status={updateStatus}
          autoCheck={config.preferences.autoCheckUpdates ?? true} autoDownload={config.preferences.autoDownloadUpdates ?? true}
          onCheck={() => { void updater?.check(); }} onDownload={() => { void updater?.download(); }}
          onInstall={() => { void updater?.install(); }} onRetry={() => { void updater?.retry(); }} onPreferences={updatePreferences}/>
      {:else if dialog === 'help'}
        <p class="eyebrow">连续写作</p><h2 id="dialog-title">写下任务，逐件完成。</h2>
        <dl class="shortcuts"><dt>Enter</dt><dd>继续任务；空任务退出列表</dd><dt>Shift Enter</dt><dd>在任务正文中换行</dd><dt>Tab / Shift Tab</dt><dd>整项缩进 / 反缩进</dd><dt>Ctrl Z / Ctrl Shift Z</dt><dd>撤销 / 重做当前项目的编辑</dd><dt>Ctrl S</dt><dd>立即保存</dd><dt>Ctrl P</dt><dd>快速查找项目</dd><dt>Ctrl Shift F</dt><dd>跨项目搜索</dd></dl>
        <p>单击复选框完成任务；按住复选框、圆点或编号拖动同级排序。左侧三角折叠正文。父项仍有未完成子项时，在菜单选择“完成整组任务”。</p><p>完成的任务连同正文移到文件末尾的 # 归档 章节；恢复后移到待办末尾。查看源码只显示当前待办或归档分区，并定位到当前阅读位置；再次点击返回原视图和进入前的位置。公式支持 KaTeX 数学语法。</p>
      {:else if dialog === 'conflict'}
        <p class="eyebrow">外部修改</p><h2 id="dialog-title">选择要保留的内容</h2><p class="muted">可先另存副本，再选择版本；也可以关闭此窗口，在编辑器中手动合并。</p>
        <div class="compare"><label>当前编辑<textarea readonly value={active?.state.doc.toString()}></textarea></label><label>磁盘版本<textarea readonly value={active?.status.external?.text}></textarea></label></div>
        <div class="modal-actions"><button onclick={() => exportMarkdown()}>另存当前副本</button><button onclick={() => resolveConflict(false)}>选用磁盘版本</button><button class="primary" onclick={() => resolveConflict(true)}>保留当前编辑</button></div>
      {:else if dialog === 'recovery'}
        <p class="eyebrow">编辑恢复</p><h2 id="dialog-title">发现一份未写入文件的草稿</h2><p>草稿与磁盘内容均保留。恢复后可继续编辑，也可先另存草稿副本。</p>
        <div class="compare"><label>恢复草稿<textarea readonly value={recovery?.text}></textarea></label><label>磁盘内容<textarea readonly value={recovery?.disk.text}></textarea></label></div>
        <div class="modal-actions"><button onclick={() => exportMarkdown(recovery?.text)}>另存草稿副本</button><button onclick={() => { dialog = null; }}>暂不恢复</button><button class="primary" onclick={recoverDraft}>恢复草稿继续编辑</button></div>
      {/if}
      {#if dialogError}<p class="dialog-error" role="alert">{dialogError}</p>{/if}
    </div>
  </div>
{/if}
