/**
 * 文件职责：通过公开 DOM 和浏览器文件端口验证真实 App 的编辑保存闭环。
 * 定义范围：任务编辑、项目隔离、搜索、主题持久化及桌面窗口控制与退出保存。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import App from '../../App.svelte';
import { BrowserFilePort, defaultPreferences } from '../browser-files';
import { builtInThemes, paletteKeys, parseTheme, type ThemeDefinition } from '../themes';
import type { AppConfig, Project, ProjectView } from '../contracts';

const desktopBoundary = vi.hoisted(() => ({
  enabled: false,
  close: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
  resized: null as null | (() => void),
  focused: null as null | ((event: { payload: boolean }) => void),
  maximized: false,
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  requestClose: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  save: vi.fn<() => Promise<string | null>>(async () => null),
  updateCheck: vi.fn<() => Promise<unknown>>(async () => null),
  updateInstall: vi.fn(async () => {}),
  updateDownload: vi.fn(async (_progress: unknown) => {}),
  updateClose: vi.fn(async () => {}),
  enterCard: vi.fn<() => Promise<void>>(async () => {}),
  exitCard: vi.fn<() => Promise<void>>(async () => {}),
}));
vi.mock('../card-window', () => ({ createCardWindowController: () => ({ enter: desktopBoundary.enterCard, exit: desktopBoundary.exitCard }) }));
vi.mock('../updater/tauri', () => ({ TauriUpdatePort: class { check = desktopBoundary.updateCheck; } }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: desktopBoundary.save }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => desktopBoundary.enabled, convertFileSrc: (path: string) => path }));
// 仅替换桌面 IO 与窗口事件边界，退出决策仍运行生产 App 代码。
vi.mock('../files/tauri', async () => {
  const { BrowserFilePort } = await import('../browser-files');
  return { TauriFilePort: BrowserFilePort, openExternalLink: vi.fn(async () => {}) };
});
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  minimize: desktopBoundary.minimize,
  toggleMaximize: desktopBoundary.toggleMaximize,
  isMaximized: async () => desktopBoundary.maximized,
  isFocused: async () => true,
  onResized: async (callback: () => void) => {
    desktopBoundary.resized = callback;
    return () => { desktopBoundary.resized = null; };
  },
  onFocusChanged: async (callback: (event: { payload: boolean }) => void) => {
    desktopBoundary.focused = callback;
    return () => { desktopBoundary.focused = null; };
  },
  close: desktopBoundary.requestClose,
  onCloseRequested: async (callback: (event: { preventDefault: () => void }) => Promise<void>) => {
    desktopBoundary.close = callback;
    return () => { desktopBoundary.close = null; };
  },
  destroy: desktopBoundary.destroy,
}) }));

const files = new BrowserFilePort();
describe('应用更新', () => {
  it('后台下载完成后保存最新正文再安装，保存失败可以重试', async () => {
    desktopBoundary.enabled = true;
    desktopBoundary.updateCheck.mockResolvedValue({
      version: '0.1.0-alpha.2', currentVersion: '0.1.0-alpha.1', body: '修复与改进',
      download: desktopBoundary.updateDownload, install: desktopBoundary.updateInstall, close: desktopBoundary.updateClose,
    });
    await start(['- [ ] 初始任务\n']);
    await vi.waitFor(() => expect(desktopBoundary.updateDownload).toHaveBeenCalledTimes(1));
    await insertTask(); await paste('安装前必须保存的正文');
    desktopBoundary.updateInstall.mockImplementation(async () => {
      expect((await files.read(firstProject.path)).text).toContain('安装前必须保存的正文');
    });
    button('更多操作').click(); await tick(); button('检查更新').click(); await tick();
    await vi.waitFor(() => expect(button('安装并重启')).toBeDefined());
    const saveConfig = vi.spyOn(BrowserFilePort.prototype, 'saveConfig').mockRejectedValue(new Error('配置只读'));
    button('安装并重启').click();
    await vi.waitFor(() => expect(button('重试')).toBeDefined());
    await vi.waitFor(() => expect(document.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false));
    expect(desktopBoundary.updateInstall).not.toHaveBeenCalled();
    saveConfig.mockRestore();
    button('重试').click();
    await vi.waitFor(() => expect(desktopBoundary.updateInstall).toHaveBeenCalledTimes(1));
    expect(await files.loadConfig()).not.toBeNull();
    expect(desktopBoundary.updateDownload).toHaveBeenCalledTimes(1);
  });
  it('安装等待配置保存时，完成任务的撤销提示不能再修改正文', async () => {
    desktopBoundary.enabled = true;
    desktopBoundary.updateCheck.mockResolvedValue({
      version: '0.1.0-alpha.2', currentVersion: '0.1.0-alpha.1',
      download: desktopBoundary.updateDownload, install: desktopBoundary.updateInstall, close: desktopBoundary.updateClose,
    });
    await start(['# 安装保护\n\n- [ ] 安装前完成的任务\n']);
    await vi.waitFor(async () => expect((await files.loadConfig())?.projectViews[firstProject.id]).toBeDefined());
    button('完成任务').click(); await tick();
    expect(button('撤销')).toBeDefined();
    button('更多操作').click(); await tick(); button('检查更新').click(); await tick();
    await vi.waitFor(() => expect(button('安装并重启')).toBeDefined());
    const visibleText = documentInput().textContent;
    let releaseConfig!: () => void;
    const configPending = new Promise<void>(resolve => { releaseConfig = resolve; });
    const writeConfig = BrowserFilePort.prototype.saveConfig;
    const saveConfig = vi.spyOn(BrowserFilePort.prototype, 'saveConfig').mockImplementation(async config => {
      await configPending; await writeConfig.call(files, config);
    });
    try {
      button('安装并重启').click();
      await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledOnce());
      const completedText = (await files.read(firstProject.path)).text;
      expect(completedText).toContain('- [x] 安装前完成的任务');
      expect(desktopBoundary.updateInstall).not.toHaveBeenCalled();
      // 配置等待点位于正文 flush 之后；此时任何有效撤销都会产生未再次保存的新事务。
      const undo = [...document.querySelectorAll<HTMLButtonElement>('.toast button')].find(candidate => candidate.textContent?.trim() === '撤销');
      undo?.click(); await tick();
      expect(documentInput().textContent).toBe(visibleText);
      expect((await files.read(firstProject.path)).text).toBe(completedText);
    } finally { releaseConfig(); }
    await vi.waitFor(() => expect(desktopBoundary.updateInstall).toHaveBeenCalledOnce());
  });
  it('普通关闭已在等待保存时启动安装，关闭请求不能提前销毁窗口', async () => {
    desktopBoundary.enabled = true;
    desktopBoundary.updateCheck.mockResolvedValue({
      version: '0.1.0-alpha.2', currentVersion: '0.1.0-alpha.1',
      download: desktopBoundary.updateDownload, install: desktopBoundary.updateInstall, close: desktopBoundary.updateClose,
    });
    await start(['- [ ] 等待安全安装\n']);
    await vi.waitFor(async () => expect((await files.loadConfig())?.projectViews[firstProject.id]).toBeDefined());
    button('更多操作').click(); await tick(); button('检查更新').click(); await tick();
    await vi.waitFor(() => expect(button('安装并重启')).toBeDefined());
    let releaseCloseConfig!: () => void;
    let releaseInstallConfig!: () => void;
    const closeConfigPending = new Promise<void>(resolve => { releaseCloseConfig = resolve; });
    const installConfigPending = new Promise<void>(resolve => { releaseInstallConfig = resolve; });
    const writeConfig = BrowserFilePort.prototype.saveConfig;
    const saveConfig = vi.spyOn(BrowserFilePort.prototype, 'saveConfig')
      .mockImplementationOnce(async config => { await closeConfigPending; await writeConfig.call(files, config); })
      .mockImplementationOnce(async config => { await installConfigPending; await writeConfig.call(files, config); });
    const close = desktopBoundary.close!({ preventDefault: vi.fn() });
    try {
      await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledOnce());
      button('安装并重启').click(); await tick();
      await vi.waitFor(() => expect(button('关闭对话框').disabled).toBe(true));
      document.querySelector<HTMLElement>('.modal-backdrop')!.click(); await tick();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      // 先完成普通关闭的配置，再让安装自己的配置保持未完成，避免以最终状态掩盖提前退出。
      releaseCloseConfig(); await close;
      await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(2));
      expect(desktopBoundary.destroy).not.toHaveBeenCalled();
      expect(desktopBoundary.updateInstall).not.toHaveBeenCalled();
    } finally { releaseCloseConfig(); releaseInstallConfig(); await close; }
    await vi.waitFor(() => expect(desktopBoundary.updateInstall).toHaveBeenCalledOnce());
    expect(desktopBoundary.destroy).not.toHaveBeenCalled();
  });
  it('更新偏好可以持久化，关闭启动检查后重启不会请求更新', async () => {
    desktopBoundary.enabled = true;
    await start(['- [ ] 任务\n']);
    await vi.waitFor(() => expect(desktopBoundary.updateCheck).toHaveBeenCalledTimes(1));
    button('更多操作').click(); await tick(); button('检查更新').click(); await tick();
    const check = document.querySelector<HTMLInputElement>('[aria-label="启动时检查更新"]')!;
    check.click(); await tick();
    await vi.waitFor(async () => expect((await files.loadConfig())?.preferences.autoCheckUpdates).toBe(false));
    await remount();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(desktopBoundary.updateCheck).toHaveBeenCalledTimes(1);
  });
});
const firstProject: Project = { id: 'project-a', name: '甲项目', path: '浏览器/甲.md' };
const secondProject: Project = { id: 'project-b', name: '乙项目', path: '浏览器/乙.md' };
let mounted: ReturnType<typeof mount> | undefined;
let container: HTMLDivElement;

/** jsdom 没有排版引擎；只补充几何 API，不替换真实编辑器、保存器或 App 行为。 */
beforeEach(() => {
  desktopBoundary.enabled = false; desktopBoundary.close = null; desktopBoundary.destroy.mockClear();
  desktopBoundary.resized = null; desktopBoundary.focused = null; desktopBoundary.maximized = false;
  desktopBoundary.minimize.mockClear();
  desktopBoundary.toggleMaximize.mockReset().mockImplementation(async () => {
    desktopBoundary.maximized = !desktopBoundary.maximized;
    desktopBoundary.resized?.();
  });
  // 自定义关闭按钮与系统关闭共享 CloseRequested，避免测试绕开退出保存契约。
  desktopBoundary.requestClose.mockReset().mockImplementation(async () => {
    if (!desktopBoundary.close) throw new Error('窗口关闭监听尚未注册');
    await desktopBoundary.close({ preventDefault: vi.fn() });
  });
  desktopBoundary.save.mockReset().mockResolvedValue(null);
  desktopBoundary.updateCheck.mockReset().mockResolvedValue(null);
  desktopBoundary.updateInstall.mockReset().mockResolvedValue(undefined);
  desktopBoundary.updateDownload.mockReset().mockResolvedValue(undefined);
  desktopBoundary.updateClose.mockReset().mockResolvedValue(undefined);
  desktopBoundary.enterCard.mockReset().mockResolvedValue(undefined);
  desktopBoundary.exitCard.mockReset().mockResolvedValue(undefined);
  // Node 的实验性同名全局不代表浏览器存储，固定使用 jsdom 的真实 Storage。
  const browserStorage = (globalThis as unknown as { jsdom: { window: { localStorage: Storage } } }).jsdom.window.localStorage;
  vi.stubGlobal('localStorage', browserStorage);
  localStorage.clear(); document.body.replaceChildren();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  if (!window.matchMedia) window.matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  container = document.createElement('div'); document.body.append(container);
});

afterEach(async () => {
  if (mounted) { await unmount(mounted); mounted = undefined; }
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/**
 * 函数职责：以真实 FilePort 写入初始文件及配置后启动 App。
 * 输入说明：项目内容按顺序对应甲、乙；界面偏好只通过持久化配置提供。
 * 输出说明：等到可编辑文档出现，不读取 Svelte 私有状态或 CodeMirror 内部对象。
 * 实现思路：预置正常启动依赖，再挂载生产组件并等待语义 DOM。
 */
async function start(texts: string[], views: Record<string, ProjectView> = {}): Promise<void> {
  const projects = [firstProject, secondProject].slice(0, texts.length);
  for (let index = 0; index < texts.length; index++) await files.create(projects[index].path, texts[index]);
  const config: AppConfig = { projects, activeProjectId: firstProject.id, preferences: { ...defaultPreferences }, projectViews: views };
  await files.saveConfig(config);
  await remount();
}

/** 重启只重新挂载 App，正文恢复必须经过持久化文件端口。 */
async function remount(): Promise<void> {
  if (mounted) await unmount(mounted);
  mounted = mount(App, { target: container });
  await tick();
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Markdown 任务文档"]')).not.toBeNull());
}

/** 按控件对外声明的名称查找，允许标签后附带任务数或快捷键。 */
function button(name: string | RegExp): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => {
    const label = (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').replace(/\s+/g, ' ').trim();
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!result) throw new Error(`找不到按钮：${String(name)}`);
  return result;
}

/** 通过用户可见路径选择项目，等待导航标题与编辑文档完成切换。 */
async function switchProject(project: Project): Promise<void> {
  const control = [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.title === project.path);
  if (!control) throw new Error(`找不到项目：${project.name}`);
  control.click(); await tick();
  await vi.waitFor(() => expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(project.name));
}

/** 返回具有公开无障碍名称的真实 CodeMirror 内容区域。 */
function documentInput(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[aria-label="Markdown 任务文档"]');
  if (!element) throw new Error('编辑文档尚未挂载'); return element;
}

/**
 * 函数职责：通过浏览器粘贴入口向当前选区输入文本。
 * 输入说明：调用前由界面命令设定光标，不访问编辑器状态或 dispatch。
 * 输出说明：真实 CodeMirror 处理剪贴板事件，触发 App 的生产 onChange 路径。
 * 实现思路：jsdom 不提供系统剪贴板，以相同接口提供当前用户粘贴文本。
 */
async function paste(text: string): Promise<void> {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: (format: string) => format === 'text/plain' ? text : '', files: [], types: ['text/plain'] } });
  documentInput().dispatchEvent(event); await tick();
}

/** 用真实键盘事件覆盖当前项目的编辑历史和应用保存快捷键。 */
async function shortcut(key: string): Promise<void> {
  documentInput().dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, bubbles: true, cancelable: true }));
  await tick();
}

/** 通过更多操作菜单新增任务，保留与用户操作相同的编辑事务。 */
async function insertTask(): Promise<void> {
  button('更多操作').click(); await tick();
  button(/^新增任务/).click(); await tick();
}

/** 等待可从文件端口重新读取的正文，避免将仅有 DOM 变化误判为已保存。 */
async function savedText(project: Project, expected: string): Promise<void> {
  await vi.waitFor(async () => expect((await files.read(project.path)).text).toBe(expected), { timeout: 5000 });
}

describe('弹窗外部关闭', () => {
  it('桌面标题栏未被遮罩覆盖的区域也能关闭弹窗并恢复焦点', async () => {
    desktopBoundary.enabled = true;
    await start(['# 清单\n']);
    const trigger = button('设置'); trigger.focus(); trigger.click(); await tick();
    document.querySelector<HTMLElement>('.breadcrumb strong')!.click(); await tick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it.each(['新增项目', '重命名项目', '移除项目关联', '查看归档项目', '阅读与外观', '检查更新', '快捷键'])('%s 内部点击保留，点击遮罩关闭', async label => {
    await start(['# 清单\n']);
    button('更多操作').click(); await tick();
    button(label).click(); await tick();
    const modal = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(modal).not.toBeNull();
    modal.click(); await tick();
    modal.querySelector<HTMLElement>('h2')!.click(); await tick();
    expect(document.querySelector('[role="dialog"]')).toBe(modal);
    document.querySelector<HTMLElement>('.modal-backdrop')!.click(); await tick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect((await files.read(firstProject.path)).text).toBe('# 清单\n');
  });
});

describe('项目归档与删除', () => {
  function projectButton(project: Project): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>('.sidebar button')].find(candidate => candidate.title === project.path);
  }

  async function openProjectMenu(project: Project): Promise<void> {
    const control = projectButton(project);
    expect(control).toBeDefined();
    control!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 140 }));
    await tick();
  }

  async function openArchivedProjects(): Promise<void> {
    button('更多操作').click(); await tick();
    button('查看归档项目').click(); await tick();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('归档项目');
  }

  it('归档非当前项目保留当前编辑，重启隐藏并可恢复且排除全部待办', async () => {
    const secondText = '- [ ] 乙项目独有任务\n';
    await start(['- [ ] 甲项目任务\n', secondText]);
    await insertTask(); await paste('甲项目持续编辑');
    await openProjectMenu(secondProject);
    expect(button('删除项目')).toBeDefined();
    button('归档项目').click(); await tick();
    await vi.waitFor(() => expect(projectButton(secondProject)).toBeUndefined());
    expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(firstProject.name);
    expect(documentInput().textContent).toContain('甲项目持续编辑');
    await vi.waitFor(async () => expect((await files.loadConfig())?.projects.find(project => project.id === secondProject.id)).toMatchObject({ archived: true }));
    expect((await files.read(secondProject.path)).text).toBe(secondText);
    await remount();
    expect(projectButton(secondProject)).toBeUndefined();
    button(/全部待办/).click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('.aggregate')?.textContent).toContain('甲项目任务'));
    expect(document.querySelector('.aggregate')?.textContent).not.toContain('乙项目独有任务');
    await openArchivedProjects();
    button(/^恢复项目/).click(); await tick();
    await vi.waitFor(() => expect(projectButton(secondProject)).toBeDefined());
    await vi.waitFor(async () => expect((await files.loadConfig())?.projects.find(project => project.id === secondProject.id)?.archived ?? false).toBe(false));
    button('关闭对话框').click(); await tick();
    await switchProject(secondProject);
    expect(documentInput().textContent).toContain('乙项目独有任务');
    await remount();
    expect(projectButton(secondProject)).toBeDefined();
  });

  it('归档当前项目保存编辑并切换到可用项目', async () => {
    await start(['- [ ] 甲项目任务\n', '- [ ] 乙项目任务\n']);
    await insertTask(); await paste('归档前的新正文');
    await openProjectMenu(firstProject); button('归档项目').click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(secondProject.name));
    expect((await files.read(firstProject.path)).text).toContain('归档前的新正文');
    await vi.waitFor(async () => expect((await files.loadConfig())?.projects.find(project => project.id === firstProject.id)).toMatchObject({ archived: true }));
    await remount();
    expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(secondProject.name);
    expect(projectButton(firstProject)).toBeUndefined();
  });

  it.each(['归档项目', '删除项目'])('%s当前项目后可恢复已缓存项目并继续编辑', async operation => {
    await start(['- [ ] 甲项目缓存任务\n', '- [ ] 乙项目任务\n']);
    await switchProject(secondProject);
    await openProjectMenu(secondProject); button(operation).click(); await tick();
    if (operation === '删除项目') { button('删除项目').click(); await tick(); }
    await vi.waitFor(() => expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(firstProject.name));
    expect(documentInput().textContent).toContain('甲项目缓存任务');
    await insertTask(); await paste('返回缓存项目后继续编辑');
    await vi.waitFor(async () => expect((await files.read(firstProject.path)).text).toContain('返回缓存项目后继续编辑'));
  });

  it('归档最后项目后重启仍可通过更多操作恢复', async () => {
    await start(['- [ ] 归档后可找回\n']);
    await openProjectMenu(firstProject); button('归档项目').click(); await tick();
    await vi.waitFor(async () => expect((await files.loadConfig())?.projects[0]).toMatchObject({ archived: true }));
    expect(document.querySelector('[aria-label="Markdown 任务文档"]')).toBeNull();
    // 无活动项目时不会挂载编辑器，因此在这个边界直接等待归档管理的公开入口。
    await unmount(mounted!);
    mounted = mount(App, { target: container }); await tick();
    await vi.waitFor(() => expect(button('更多操作')).toBeDefined());
    expect(projectButton(firstProject)).toBeUndefined();
    await openArchivedProjects();
    await vi.waitFor(() => expect(button(/^恢复项目/)).toBeDefined());
    button(/^恢复项目/).click(); await tick();
    await vi.waitFor(() => expect(projectButton(firstProject)).toBeDefined());
    button('关闭对话框').click(); await tick();
    await switchProject(firstProject);
    expect(documentInput().textContent).toContain('归档后可找回');
  });

  it('正文与恢复数据保存失败时归档保留项目及唯一内存草稿', async () => {
    const original = '- [ ] 磁盘原文\n';
    await start([original]);
    vi.spyOn(BrowserFilePort.prototype, 'saveRecovery').mockRejectedValue(new Error('FILE_PERMISSION: 恢复目录不可写'));
    await insertTask(); await paste('归档不能丢失的草稿');
    await openProjectMenu(firstProject); button('归档项目').click(); await tick();
    await new Promise(resolve => setTimeout(resolve, 0)); await tick();
    expect(projectButton(firstProject)).toBeDefined();
    expect(documentInput().textContent).toContain('归档不能丢失的草稿');
    expect((await files.loadConfig())?.projects[0].archived ?? false).toBe(false);
    expect((await files.read(firstProject.path)).text).toBe(original);
  });

  it('删除非当前项目只移除选中关联，删除最后项目保留文件并清空编辑器', async () => {
    const firstText = '- [ ] 甲项目任务\n';
    const secondText = '- [ ] 乙项目任务\n';
    await start([firstText, secondText]);
    await openProjectMenu(secondProject); button('删除项目').click(); await tick();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('删除「乙项目」项目？');
    button('删除项目').click(); await tick();
    await vi.waitFor(() => expect(projectButton(secondProject)).toBeUndefined());
    expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(firstProject.name);
    expect(documentInput().textContent).toContain('甲项目任务');
    expect((await files.read(secondProject.path)).text).toBe(secondText);
    await vi.waitFor(async () => expect((await files.loadConfig())?.projects.map(project => project.id)).toEqual([firstProject.id]));
    await openProjectMenu(firstProject); button('删除项目').click(); await tick();
    button('删除项目').click(); await tick();
    await vi.waitFor(async () => expect((await files.loadConfig())?.projects).toEqual([]));
    expect(document.querySelector('[aria-label="Markdown 任务文档"]')).toBeNull();
    expect((await files.read(firstProject.path)).text).toBe(firstText);
  });
});

describe('左栏项目拖动排序', () => {
  function projectButton(project: Project): HTMLButtonElement {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.title === project.path)!;
  }

  function projectOrder(): string[] {
    return [...document.querySelectorAll<HTMLButtonElement>('button')]
      .filter(candidate => [firstProject.path, secondProject.path].includes(candidate.title))
      .map(candidate => candidate.title);
  }

  /** jsdom 不提供 DragEvent；保留浏览器事件入口及坐标、传输数据契约。 */
  function dragEvent(type: string, clientY = 0): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientY: { value: clientY },
      dataTransfer: { value: { effectAllowed: 'all', dropEffect: 'none', setData: vi.fn(), getData: () => '', types: [] } },
    });
    return event;
  }

  it.each([
    { name: '拖到项目下半部插入其后', source: firstProject, target: secondProject, clientY: 130 },
    { name: '拖到项目上半部插入其前', source: secondProject, target: firstProject, clientY: 110 },
  ])('$name，并保留活动项目及重启后的顺序', async ({ source, target, clientY }) => {
    await start(['- [ ] 甲任务\n', '- [ ] 乙任务\n']);
    await vi.waitFor(async () => expect((await files.loadConfig())?.projectViews[firstProject.id]).toBeDefined());
    const sourceControl = projectButton(source);
    const targetControl = projectButton(target);
    expect(sourceControl.draggable).toBe(true);
    vi.spyOn(targetControl, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140, height: 40 } as DOMRect);
    sourceControl.dispatchEvent(dragEvent('dragstart')); await tick();
    targetControl.dispatchEvent(dragEvent('dragover', clientY)); await tick();
    expect((await files.loadConfig())?.projects.map(project => project.id)).toEqual([firstProject.id, secondProject.id]);
    targetControl.dispatchEvent(dragEvent('drop', clientY)); await tick();
    sourceControl.dispatchEvent(dragEvent('dragend')); await tick();
    await vi.waitFor(async () => expect((await files.loadConfig())?.projects.map(project => project.id)).toEqual([secondProject.id, firstProject.id]));
    expect(projectOrder()).toEqual([secondProject.path, firstProject.path]);
    expect((await files.loadConfig())?.activeProjectId).toBe(firstProject.id);
    expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(firstProject.name);
    await remount();
    expect(projectOrder()).toEqual([secondProject.path, firstProject.path]);
    expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(firstProject.name);
  });

  it('取消拖动及外部拖放不保存项目顺序', async () => {
    await start(['- [ ] 甲任务\n', '- [ ] 乙任务\n']);
    await vi.waitFor(async () => expect((await files.loadConfig())?.projectViews[firstProject.id]).toBeDefined());
    const save = vi.spyOn(BrowserFilePort.prototype, 'saveConfig');
    const source = projectButton(firstProject);
    const target = projectButton(secondProject);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140, height: 40 } as DOMRect);
    source.dispatchEvent(dragEvent('dragstart')); await tick();
    target.dispatchEvent(dragEvent('dragover', 130)); await tick();
    source.dispatchEvent(dragEvent('dragend')); await tick();
    target.dispatchEvent(dragEvent('dragover', 130));
    target.dispatchEvent(dragEvent('drop', 130)); await tick();
    expect(save).not.toHaveBeenCalled();
    expect(projectOrder()).toEqual([firstProject.path, secondProject.path]);
    expect((await files.loadConfig())?.projects.map(project => project.id)).toEqual([firstProject.id, secondProject.id]);
  });
});

/** 从关联标签定位设置控件，测试不依赖组件状态或固定 DOM 排列。 */
function themeControl(name: string): HTMLSelectElement {
  const label = [...document.querySelectorAll('label')].find(candidate => candidate.firstChild?.textContent?.trim() === name);
  const select = label?.querySelector('select');
  if (!select) throw new Error(`找不到设置：${name}`);
  return select;
}

async function chooseThemeSetting(name: string, value: string): Promise<void> {
  const select = themeControl(name); select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true })); await tick();
}

/** jsdom 的 File 缺少 text；只补文件读取边界，仍通过生产文件输入事件执行导入与校验。 */
async function importThemeFile(content: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[aria-label="导入主题文件"]')!;
  const file = new File([content], 'custom-theme.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => content });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change', { bubbles: true })); await tick();
  await vi.waitFor(() => expect(button('导入主题').disabled).toBe(false));
}

describe('App 更多操作菜单', () => {
  it('内部点击保留菜单，外部点击关闭，触发按钮仍能切换且菜单操作正常', async () => {
    await start(['# 菜单验收\n']);
    const trigger = button('更多操作');
    trigger.click(); await tick();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    menu.click(); await tick();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    documentInput().click(); await tick();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    trigger.click(); await tick();
    trigger.click(); await tick();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    trigger.click(); await tick();
    button('快捷键').click(); await tick();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('App 主题导入与持久化', () => {
  const customTheme: ThemeDefinition = {
    ...builtInThemes[0], id: 'custom-slate', name: '自制石板', corners: 'square',
    light: { ...builtInThemes[0].light, canvas: '#ABCDEF' }, dark: { ...builtInThemes[0].dark, canvas: '#123456' },
    appearance: {
      light: { 'control-shadow': '3px 3px 6px #123456', 'control-radius': 9 },
      dark: { 'control-shadow': '2px 2px 5px #102030', 'control-radius': 7 },
    },
  };

  it('设置中选择双色深色并保存，重新挂载恢复同一主题与完整配色', async () => {
    await start(['# 主题验收\n']); button('设置').click(); await tick();
    await chooseThemeSetting('主题', 'mono'); await chooseThemeSetting('明暗模式', 'dark');
    await vi.waitFor(async () => expect((await files.loadConfig())?.preferences).toMatchObject({ themeId: 'mono', theme: 'dark' }));
    await remount(); button('设置').click(); await tick();
    expect(themeControl('主题').value).toBe('mono'); expect(themeControl('明暗模式').value).toBe('dark');
    expect(document.documentElement.dataset.monochrome).toBe('true');
    expect(document.documentElement.dataset.corners).toBe('square');
    for (const key of paletteKeys) expect(document.documentElement.style.getPropertyValue(`--${key}`)).toBe(builtInThemes[1].dark[key]);
  });

  it('文件输入导入双模式主题后自动选择，保存并重启恢复自制配色', async () => {
    await start(['# 导入主题\n']); button('设置').click(); await tick();
    await chooseThemeSetting('明暗模式', 'light'); await importThemeFile(JSON.stringify(customTheme));
    expect(themeControl('主题').value).toBe(customTheme.id);
    expect(document.documentElement.style.getPropertyValue('--canvas')).toBe('#ABCDEF');
    expect(document.documentElement.dataset.corners).toBe('square');
    expect(document.documentElement.style.getPropertyValue('--control-shadow')).toBe(customTheme.appearance!.light['control-shadow']);
    expect(document.documentElement.style.getPropertyValue('--control-radius')).toBe('9px');
    await vi.waitFor(async () => {
      const config = await files.loadConfig();
      expect(config?.preferences.themeId).toBe(customTheme.id); expect(config?.customThemes).toEqual([customTheme]);
    });
    await remount(); button('设置').click(); await tick();
    expect(themeControl('主题').value).toBe(customTheme.id);
    expect(document.documentElement.style.getPropertyValue('--control-shadow')).toBe(customTheme.appearance!.light['control-shadow']);
    expect(document.documentElement.style.getPropertyValue('--control-radius')).toBe('9px');
    await chooseThemeSetting('明暗模式', 'dark');
    expect(document.documentElement.dataset.corners).toBe('square');
    expect(document.documentElement.style.getPropertyValue('--canvas')).toBe('#123456');
    expect(document.documentElement.style.getPropertyValue('--control-shadow')).toBe(customTheme.appearance!.dark['control-shadow']);
    expect(document.documentElement.style.getPropertyValue('--control-radius')).toBe('7px');
  });

  it('内置包重复导入不覆盖已有主题', async () => {
    await start(['# 重复主题\n']); button('设置').click(); await tick();
    await importThemeFile(JSON.stringify(builtInThemes[1]));
    expect(document.querySelector('.dialog-error')?.textContent).toContain('THEME_DUPLICATE');
    expect(themeControl('主题').value).toBe('paper');
    expect((await files.loadConfig())?.customThemes ?? []).toEqual([]);
  });

  it('非法文件显示错误，保留已选择的主题及持久化配置', async () => {
    await start(['# 非法导入\n']); button('设置').click(); await tick();
    await chooseThemeSetting('主题', 'mono'); await chooseThemeSetting('明暗模式', 'dark');
    await vi.waitFor(async () => expect((await files.loadConfig())?.preferences.themeId).toBe('mono'));
    await importThemeFile(JSON.stringify({ ...customTheme, dark: { canvas: 'url(https://example.com)' } }));
    expect(document.querySelector('.dialog-error')?.textContent).toContain('THEME_INVALID');
    expect(themeControl('主题').value).toBe('mono');
    expect(document.documentElement.style.getPropertyValue('--canvas')).toBe('#0A0A0A');
    const saved = await files.loadConfig();
    expect(saved?.preferences.themeId).toBe('mono'); expect(saved?.customThemes ?? []).toEqual([]);
  });

  it('移除自制主题回退纸面，重启后主题列表不再包含已移除项', async () => {
    await start(['# 移除主题\n']); button('设置').click(); await tick();
    await importThemeFile(JSON.stringify(customTheme)); button('移除主题').click(); await tick();
    expect(themeControl('主题').value).toBe('paper');
    expect(document.documentElement.style.getPropertyValue('--control-shadow')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--control-radius')).toBe('');
    await vi.waitFor(async () => {
      const config = await files.loadConfig();
      expect(config?.preferences.themeId).toBe('paper'); expect(config?.customThemes).toEqual([]);
    });
    await remount(); button('设置').click(); await tick();
    expect(themeControl('主题').value).toBe('paper');
    expect([...themeControl('主题').options].some(option => option.value === customTheme.id)).toBe(false);
    expect(document.documentElement.dataset.corners).toBe('rounded');
    expect(document.documentElement.style.getPropertyValue('--control-shadow')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--control-radius')).toBe('');
  });

  it('跟随系统即时响应明暗事件，手动选择浅色后保持浅色', async () => {
    let systemDark = false;
    const events = new EventTarget();
    const preference = { get matches() { return systemDark; }, media: '(prefers-color-scheme: dark)', onchange: null, addListener() {}, removeListener() {}, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) } as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(preference);
    await start(['# 系统主题\n']); button('设置').click(); await tick();
    await chooseThemeSetting('主题', 'mono'); await chooseThemeSetting('明暗模式', 'system');
    expect(document.documentElement.style.getPropertyValue('--canvas')).toBe('#F8FAFC');
    systemDark = true; events.dispatchEvent(new Event('change')); await tick();
    expect(document.documentElement.style.getPropertyValue('--canvas')).toBe('#0A0A0A');
    expect(themeControl('明暗模式').value).toBe('system');
    await chooseThemeSetting('明暗模式', 'light');
    systemDark = false; events.dispatchEvent(new Event('change')); await tick();
    systemDark = true; events.dispatchEvent(new Event('change')); await tick();
    expect(document.documentElement.style.getPropertyValue('--canvas')).toBe('#F8FAFC');
  });
});

describe('App 卡片模式', () => {
  /** 用可控完成点验证可见性事务，避免真实计时或 jsdom 缺少 WAAPI 掩盖调用顺序。 */
  function controlledAnimation() {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    return { finished, finish, fail, cancel: vi.fn() };
  }

  it('淡出完成后才切换原生窗口，新布局在淡入完成前保持禁止交互', async () => {
    desktopBoundary.enabled = true;
    await start(['- [ ] 平滑切换\n']);
    const shell = document.querySelector<HTMLElement>('.app-shell')!;
    for (const entering of [true, false]) {
      const fadeOut = controlledAnimation();
      const fadeIn = controlledAnimation();
      const animate = vi.fn().mockReturnValueOnce(fadeOut).mockReturnValueOnce(fadeIn);
      Object.defineProperty(shell, 'animate', { value: animate, configurable: true });
      const native = entering ? desktopBoundary.enterCard : desktopBoundary.exitCard;
      const nativePending = controlledAnimation();
      native.mockReturnValueOnce(nativePending.finished);
      const control = button(entering ? '进入卡片模式' : '退出卡片模式');
      try {
        control.click(); control.click(); await tick();
        expect(animate).toHaveBeenCalledOnce();
        expect(native).not.toHaveBeenCalled();
        expect(shell.inert).toBe(true);
        expect(shell.classList.contains('card-mode')).toBe(!entering);

        fadeOut.finish();
        await vi.waitFor(() => expect(native).toHaveBeenCalledWith({ animate: true }));
        expect(native).toHaveBeenCalledOnce();
        expect(fadeOut.cancel).not.toHaveBeenCalled();
        expect(animate).toHaveBeenCalledOnce();
        expect(shell.classList.contains('card-mode')).toBe(!entering);

        nativePending.finish();
        await vi.waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
        expect(fadeOut.cancel).toHaveBeenCalledOnce();
        expect(shell.classList.contains('card-mode')).toBe(entering);
        expect(shell.inert).toBe(true);
        expect(control.disabled).toBe(true);
        expect(fadeIn.cancel).not.toHaveBeenCalled();
      } finally { fadeOut.finish(); nativePending.finish(); fadeIn.finish(); }
      await vi.waitFor(() => expect(shell.inert).toBe(false));
      expect(control.disabled).toBe(false);
      expect(fadeIn.cancel).toHaveBeenCalledOnce();
    }
  });

  it.each(['淡出', '原生'] as const)('%s失败时清理透明动画并恢复交互，保留原模式', async stage => {
    desktopBoundary.enabled = true;
    await start(['- [ ] 可恢复的动画失败\n']);
    const shell = document.querySelector<HTMLElement>('.app-shell')!;
    const fadeOut = controlledAnimation();
    const animate = vi.fn().mockReturnValue(fadeOut);
    Object.defineProperty(shell, 'animate', { value: animate, configurable: true });
    if (stage === '原生') desktopBoundary.enterCard.mockRejectedValueOnce(new Error('原生切换失败'));
    button('进入卡片模式').click(); await tick();
    expect(shell.inert).toBe(true);
    if (stage === '淡出') fadeOut.fail(new Error('动画已取消'));
    else fadeOut.finish();
    await vi.waitFor(() => expect(shell.inert).toBe(false));
    expect(fadeOut.cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledOnce();
    expect(shell.classList.contains('card-mode')).toBe(false);
    expect(button('进入卡片模式').disabled).toBe(false);
    expect(desktopBoundary.enterCard).toHaveBeenCalledTimes(stage === '原生' ? 1 : 0);
  });

  it('减少动态效果时跳过布局动画，并让原生进入和退出跳过动画', async () => {
    desktopBoundary.enabled = true;
    const media = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...media(query), matches: query === '(prefers-reduced-motion: reduce)' }));
    await start(['- [ ] 减少动态效果\n']);
    const shell = document.querySelector<HTMLElement>('.app-shell')!;
    const animate = vi.fn();
    Object.defineProperty(shell, 'animate', { value: animate, configurable: true });
    button('进入卡片模式').click();
    await vi.waitFor(() => expect(button('退出卡片模式').disabled).toBe(false));
    expect(desktopBoundary.enterCard).toHaveBeenCalledWith({ animate: false });
    button('退出卡片模式').click();
    await vi.waitFor(() => expect(button('进入卡片模式').disabled).toBe(false));
    expect(desktopBoundary.exitCard).toHaveBeenCalledWith({ animate: false });
    expect(animate).not.toHaveBeenCalled();
    expect(shell.inert).toBe(false);
  });

  it('源码按钮右侧的同一按钮切换卡片布局，保留编辑器与编辑保存能力', async () => {
    await start(['- [ ] 原任务\n']);
    const editor = documentInput();
    const control = button('进入卡片模式');
    expect(control.closest('.statusbar-actions')).not.toBeNull();
    expect(button('查看源码').compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(control.querySelector('svg')).not.toBeNull();
    expect(control.getAttribute('aria-pressed')).toBe('false');

    control.click(); await tick();
    await vi.waitFor(() => expect(button('退出卡片模式').getAttribute('aria-pressed')).toBe('true'));
    expect(document.querySelector('.app-shell.card-mode')).not.toBeNull();
    expect(document.querySelector('header.topbar')).toBeNull();
    await vi.waitFor(() => expect(document.querySelector('aside.sidebar')).toBeNull());
    expect(document.querySelector('.viewbar')).toBeNull();
    expect(button('退出卡片模式')).toBe(control);
    expect(documentInput()).toBe(editor);
    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(control.closest('footer')).not.toBeNull();
    await paste('卡片中新增正文');
    await vi.waitFor(async () => expect((await files.read(firstProject.path)).text).toContain('卡片中新增正文'));

    control.click(); await tick();
    await vi.waitFor(() => expect(button('进入卡片模式').getAttribute('aria-pressed')).toBe('false'));
    expect(document.querySelector('.app-shell.card-mode')).toBeNull();
    expect(document.querySelector('header.topbar')).not.toBeNull();
    expect(document.querySelector('aside.sidebar')).not.toBeNull();
    expect(document.querySelector('.viewbar')).not.toBeNull();
    expect(documentInput()).toBe(editor);
    expect(editor.textContent).toContain('卡片中新增正文');
    expect(desktopBoundary.enterCard).not.toHaveBeenCalled();
    expect(desktopBoundary.exitCard).not.toHaveBeenCalled();
  });

  it('原生进入或退出失败保留原模式，并允许用户重试', async () => {
    desktopBoundary.enabled = true;
    await start(['- [ ] 桌面任务\n']);
    desktopBoundary.enterCard.mockRejectedValueOnce(new Error('进入卡片失败'));
    button('进入卡片模式').click();
    await vi.waitFor(() => expect(desktopBoundary.enterCard).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(button('进入卡片模式').disabled).toBe(false));
    expect(document.querySelector('.app-shell.card-mode')).toBeNull();

    button('进入卡片模式').click();
    await vi.waitFor(() => expect(button('退出卡片模式').disabled).toBe(false));
    expect(document.querySelector('.app-shell.card-mode')).not.toBeNull();
    desktopBoundary.exitCard.mockRejectedValueOnce(new Error('退出卡片失败'));
    button('退出卡片模式').click();
    await vi.waitFor(() => expect(desktopBoundary.exitCard).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(button('退出卡片模式').disabled).toBe(false));
    expect(document.querySelector('.app-shell.card-mode')).not.toBeNull();

    button('退出卡片模式').click();
    await vi.waitFor(() => expect(button('进入卡片模式').disabled).toBe(false));
    expect(document.querySelector('.app-shell.card-mode')).toBeNull();
    expect(desktopBoundary.enterCard).toHaveBeenCalledTimes(2);
    expect(desktopBoundary.exitCard).toHaveBeenCalledTimes(2);
  });

  it('窗口切换等待期间禁止重复点击，完成后才更新模式', async () => {
    desktopBoundary.enabled = true;
    await start(['- [ ] 异步窗口任务\n']);
    for (const entering of [true, false]) {
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      const transition = entering ? desktopBoundary.enterCard : desktopBoundary.exitCard;
      transition.mockReturnValueOnce(pending);
      const control = button(entering ? '进入卡片模式' : '退出卡片模式');
      try {
        // 连续事件在 Svelte 刷新 disabled 前到达，也只能启动一次窗口事务。
        control.click(); control.click(); await tick();
        expect(transition).toHaveBeenCalledOnce();
        expect(control.disabled).toBe(true);
        expect(document.querySelector('.app-shell')?.classList.contains('card-mode')).toBe(!entering);
        control.click();
        expect(transition).toHaveBeenCalledOnce();
      } finally { finish(); }
      await vi.waitFor(() => expect(button(entering ? '退出卡片模式' : '进入卡片模式').disabled).toBe(false));
      expect(document.querySelector('.app-shell')?.classList.contains('card-mode')).toBe(entering);
    }
  });
});

describe('App 顶部工具栏窗口控制', () => {
  it('浏览器预览不展示桌面窗口控制', async () => {
    await start(['# 浏览器预览\n']);
    expect(document.querySelector('[aria-label="窗口控制"]')).toBeNull();
    expect(document.querySelector('[aria-label="关闭窗口"]')).toBeNull();
  });

  it('最小化与最大化按钮调用窗口边界，窗口状态变化后可还原', async () => {
    desktopBoundary.enabled = true;
    await start(['# 桌面窗口\n']);
    await vi.waitFor(() => expect(desktopBoundary.resized).not.toBeNull());
    const controls = document.querySelector('[aria-label="窗口控制"]');
    expect(controls).not.toBeNull();
    expect(controls?.closest('.topbar')).not.toBeNull();
    expect(document.querySelector('.window-titlebar')).toBeNull();
    expect(document.body.textContent?.match(/Foldmark/g)).toHaveLength(1);
    expect(document.querySelector('.sidebar .brand')?.textContent).toContain('Foldmark');
    button('最小化').click();
    await vi.waitFor(() => expect(desktopBoundary.minimize).toHaveBeenCalledOnce());
    button('最大化').click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="还原"]')).not.toBeNull());
    button('还原').click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="最大化"]')).not.toBeNull());
    expect(desktopBoundary.toggleMaximize).toHaveBeenCalledTimes(2);
  });

  it('点击关闭先保存正文，保存失败保留草稿并允许重试退出', async () => {
    desktopBoundary.enabled = true;
    const original = '# 退出保存\n';
    await start([original]);
    await vi.waitFor(() => expect(desktopBoundary.close).not.toBeNull());
    const saveRecovery = vi.spyOn(BrowserFilePort.prototype, 'saveRecovery').mockRejectedValue(new Error('FILE_PERMISSION: 恢复目录不可写'));
    await insertTask(); await paste('关闭时不能丢失的草稿');
    button('关闭窗口').click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('FILE_PERMISSION'));
    expect(desktopBoundary.requestClose).toHaveBeenCalledOnce();
    expect(desktopBoundary.destroy).not.toHaveBeenCalled();
    expect(documentInput().textContent).toContain('关闭时不能丢失的草稿');
    expect((await files.read(firstProject.path)).text).toBe(original);
    saveRecovery.mockRestore();
    button('关闭窗口').click();
    await vi.waitFor(() => expect(desktopBoundary.destroy).toHaveBeenCalledOnce());
    expect((await files.read(firstProject.path)).text).toBe(`${original}- [ ] 关闭时不能丢失的草稿`);
  });
});

describe('App 桌面主题模板下载', () => {
  const exportPath = '浏览器/custom-mono.json';

  beforeEach(() => {
    desktopBoundary.enabled = true;
    // 桌面下载必须经过保存对话框；拦截浏览器导航，避免旧实现的无关 jsdom 报错掩盖断言。
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(): string { return 'blob:theme-template'; }
      static revokeObjectURL(): void {}
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  it.each(['mono', 'neumorphic'])('选择位置后落盘 %s 完整双模式模板，并反馈保存成功', async (themeId) => {
    const selected = builtInThemes.find(theme => theme.id === themeId)!;
    const templateId = `custom-${themeId}`;
    const selectedExportPath = `浏览器/${templateId}.json`;
    desktopBoundary.save.mockResolvedValue(selectedExportPath);
    await start(['# 下载模板\n']); button('设置').click(); await tick();
    await chooseThemeSetting('主题', themeId);
    button('下载主题模板').click(); await tick();
    await vi.waitFor(() => expect(desktopBoundary.save).toHaveBeenCalledWith({
      title: '保存主题模板', defaultPath: `${templateId}.json`, filters: [{ name: 'JSON 主题', extensions: ['json'] }],
    }));
    await vi.waitFor(async () => {
      const template = parseTheme((await files.read(selectedExportPath)).text);
      expect(template.id).toBe(templateId);
      expect(template.light).toEqual(selected.light);
      expect(template.dark).toEqual(selected.dark);
      expect(template.appearance).toEqual(selected.appearance);
    });
    expect(document.body.textContent).toContain('主题模板已保存');
  });

  it('取消保存不创建文件、不报成功，并允许重新下载', async () => {
    await start(['# 取消下载\n']); button('设置').click(); await tick();
    const create = vi.spyOn(BrowserFilePort.prototype, 'create');
    button('下载主题模板').click(); await tick();
    await vi.waitFor(() => expect(desktopBoundary.save).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(button('下载主题模板').disabled).toBe(false));
    expect(create).not.toHaveBeenCalled();
    expect(document.querySelector('.dialog-error')).toBeNull();
    expect(document.body.textContent).not.toContain('主题模板已保存');
  });

  it('保存失败在设置中显示错误并保留已有文件', async () => {
    await files.create(exportPath, '原有内容');
    desktopBoundary.save.mockResolvedValue(exportPath);
    await start(['# 保存失败\n']); button('设置').click(); await tick();
    button('下载主题模板').click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('.dialog-error')?.textContent).toContain('FILE_EXISTS'));
    expect((await files.read(exportPath)).text).toBe('原有内容');
    expect(button('下载主题模板').disabled).toBe(false);
    expect(document.body.textContent).not.toContain('主题模板已保存');
  });

  it('系统保存对话框失败显示错误，并恢复下载按钮', async () => {
    desktopBoundary.save.mockRejectedValue(new Error('保存对话框不可用'));
    await start(['# 对话框失败\n']); button('设置').click(); await tick();
    button('下载主题模板').click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('.dialog-error')?.textContent).toContain('保存对话框不可用'));
    expect(button('下载主题模板').disabled).toBe(false);
  });
});

describe('App 真实编辑与文件闭环', () => {
  it('状态栏当前页字数随编辑、撤销和项目切换更新，源码切换保留统计', async () => {
    await start(['中文 😀\n', '第二份\n']);
    const status = () => button('快捷键').textContent;
    expect(status()).toBe('3 字 · Markdown');
    button('查看源码').click(); await tick();
    expect(status()).toBe('3 字 · Markdown');
    await paste('新增');
    expect(status()).toBe('5 字 · Markdown');
    await shortcut('z');
    expect(status()).toBe('3 字 · Markdown');
    await switchProject(secondProject);
    expect(status()).toBe('3 字 · Markdown');
    button(/^全部待办/).click(); await tick();
    expect(status()).toBe('快捷键');
  });

  it('待办和归档各自计数，源码仅统计来源分区', async () => {
    await start(['# 清单\n\n- [ ] 待办\n\n# 归档\n\n- [x] 已完成\n']);
    const status = () => button('快捷键').textContent;
    expect(status()).toBe('8 字 · Markdown');
    button('查看源码').click(); await tick();
    expect(status()).toBe('8 字 · Markdown');
    button('返回预览').click(); await tick();
    button(/^归档/).click(); await tick();
    expect(status()).toBe('10 字 · Markdown');
    button('查看源码').click(); await tick();
    expect(status()).toBe('10 字 · Markdown');
    button('返回预览').click(); await tick();
    button(/^待办/).click(); await tick();
    expect(status()).toBe('8 字 · Markdown');
  });

  it.each(['todo', 'source'] as const)('%s 视图通过 Ctrl N 新增任务并支持撤销', async mode => {
    await start(['# 清单\n']);
    if (mode === 'source') { button('查看源码').click(); await tick(); }
    await shortcut('n');
    await shortcut('s');
    await savedText(firstProject, '# 清单\n- [ ] ');
    expect(document.activeElement).toBe(documentInput());
    await shortcut('z');
    await shortcut('s');
    await savedText(firstProject, '# 清单\n');
  });

  it('新增任务支持 Command N，并忽略组合输入、长按和额外修饰键', async () => {
    await start(['# 清单\n']);
    for (const modifiers of [{ isComposing: true }, { repeat: true }, { altKey: true }, { shiftKey: true }]) {
      documentInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true, ...modifiers }));
    }
    button('查找项目').click(); await tick();
    document.getElementById('project-filter')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
    await shortcut('s');
    await savedText(firstProject, '# 清单\n');
    documentInput().click(); await tick();
    const event = new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true });
    documentInput().dispatchEvent(event); await tick();
    expect(event.defaultPrevented).toBe(true);
    await shortcut('s');
    await savedText(firstProject, '# 清单\n- [ ] ');
  });

  it('快捷键弹窗仅显示按键说明，打开时和全部待办中不新增任务', async () => {
    await start(['# 清单\n']);
    const help = button('快捷键');
    expect(help.closest('footer')).not.toBeNull();
    expect(help.textContent).toBe('3 字 · Markdown');
    help.click(); await tick();
    const modal = document.querySelector('[role="dialog"]')!;
    expect(modal.querySelector('h2')?.textContent).toBe('快捷键');
    expect(modal.querySelectorAll('p')).toHaveLength(0);
    expect(modal.querySelector('dl')?.textContent).toContain('Ctrl N新增任务');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await tick();
    button(/^全部待办/).click(); await tick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
    await switchProject(firstProject);
    await shortcut('s');
    await savedText(firstProject, '# 清单\n');
  });

  it('项目搜索按需打开，搜索内部点击保留、外部点击关闭且清除隐藏筛选', async () => {
    await start(['# 甲\n', '# 乙\n']);
    expect(document.getElementById('project-filter')).toBeNull();
    button('查找项目').click(); await tick();
    const filter = document.getElementById('project-filter') as HTMLInputElement;
    expect(document.activeElement).toBe(filter);
    filter.value = '乙'; filter.dispatchEvent(new Event('input', { bubbles: true })); await tick();
    expect(document.querySelectorAll('.project-list button')).toHaveLength(1);
    filter.click(); await tick();
    expect(document.getElementById('project-filter')).toBe(filter);
    await switchProject(secondProject);
    expect(document.getElementById('project-filter')).toBeNull();
    expect(document.querySelectorAll('.project-list button')).toHaveLength(2);
    await shortcut('p');
    expect(document.getElementById('project-filter')).not.toBeNull();
    button(/^搜索/).click(); await tick();
    expect(document.getElementById('project-filter')).toBeNull();
    const globalSearch = document.getElementById('global-search') as HTMLInputElement;
    globalSearch.click(); await tick();
    expect(document.getElementById('global-search')).toBe(globalSearch);
    documentInput().click(); await tick();
    expect(document.getElementById('global-search')).toBeNull();
  });

  it('顶部星号跟随正文保存，底部源码入口切换真实编辑视图', async () => {
    await start(['# 清单\n']);
    expect(document.querySelector('.unsaved-mark')).toBeNull();
    const sourceButton = button('查看源码');
    expect(sourceButton.closest('footer')).not.toBeNull();
    sourceButton.click(); await tick();
    expect(sourceButton.getAttribute('aria-pressed')).toBe('true');
    await insertTask();
    expect(document.querySelector('.breadcrumb [aria-label="未保存"]')).not.toBeNull();
    await shortcut('s');
    await savedText(firstProject, '# 清单\n- [ ] ');
    await vi.waitFor(() => expect(document.querySelector('.unsaved-mark')).toBeNull());
    sourceButton.click(); await tick();
    expect(sourceButton.getAttribute('aria-pressed')).toBe('false');
    expect(button(/^待办/).classList.contains('tab-active')).toBe(true);
  });

  it('围栏回车补全和语言输入通过真实保存路径持久化', async () => {
    const source = '# 代码\n\n```';
    await start([source], { [firstProject.id]: { mode: 'todo', cursor: source.length, scrollTop: 0, folded: [] } });
    documentInput().focus();
    documentInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick(); await paste('console.log(1)');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="代码块语言"]')!;
    expect(input).not.toBeNull();
    input.focus(); input.value = 'javascript';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    // 预览模式补全围栏时保留块后续写段落，保存和重启均应保留其分隔空行。
    const expected = '# 代码\n\n```javascript\nconsole.log(1)\n```\n\n';
    await savedText(firstProject, expected);
    await remount();
    expect((await files.read(firstProject.path)).text).toBe(expected);
    expect(documentInput().textContent).toContain('console.log(1)');
  });

  it('全部待办按章节位置显示段首标题，同名章节不合并且任务保持原序', async () => {
    await start(['- [ ] 无章节任务\n\n# 清单\n\n- [ ] 第一项\n- [ ] 第二项\n\n# 清单\n\n- [ ] 第三项\n\n## 已完成章节\n\n- [x] 已完成\n']);
    button(/全部待办/).click(); await tick();
    await vi.waitFor(() => expect(document.querySelectorAll('.aggregate-task')).toHaveLength(4));
    const content = [...document.querySelectorAll('.aggregate-section-heading, .aggregate-title')].map(node => node.textContent);
    expect(content).toEqual(['无章节任务', '清单', '第一项', '第二项', '清单', '第三项']);
    expect(document.querySelector('.aggregate-task small')).toBeNull();
  });

  it('归档源码仅显示归档分区，切换项目和重启后返回来源预览', async () => {
    const source = '- [ ] 待办独有文字\n\n# 归档\n\n- [x] 归档独有文字\n';
    await start([source, '- [ ] 第二项目\n']);
    button(/^归档/).click(); await tick();
    button('查看源码').click(); await tick();
    expect(button('返回预览').getAttribute('aria-pressed')).toBe('true');
    expect(button(/^归档/).classList.contains('tab-active')).toBe(true);
    expect(documentInput().textContent).toContain('[x] 归档独有文字');
    expect(documentInput().textContent).not.toContain('待办独有文字');
    await switchProject(secondProject); await switchProject(firstProject);
    expect(button('返回预览').getAttribute('aria-pressed')).toBe('true');
    await vi.waitFor(async () => expect((await files.loadConfig())?.projectViews[firstProject.id].sourceView).toBe('archive'));
    expect((await files.loadConfig())?.projectViews[firstProject.id].sourceReturn).toEqual(expect.objectContaining({ cursor: expect.any(Number), scrollTop: expect.any(Number), anchor: expect.any(Number), offset: expect.any(Number) }));
    await remount();
    expect(button('返回预览').getAttribute('aria-pressed')).toBe('true');
    button('返回预览').click(); await tick();
    expect(button(/^归档/).classList.contains('tab-active')).toBe(true);
    expect(documentInput().textContent).toContain('归档独有文字');
    expect(documentInput().textContent).not.toContain('[x]');
    expect((await files.read(firstProject.path)).text).toBe(source);
  });

  it('旧源码配置默认显示待办源码，并可返回待办预览', async () => {
    await start(['- [ ] 待办原文\n\n# 归档\n\n- [x] 归档原文\n'], { [firstProject.id]: { mode: 'source', cursor: 0, scrollTop: 0, folded: [] } });
    expect(documentInput().textContent).toContain('[ ] 待办原文');
    expect(documentInput().textContent).not.toContain('归档原文');
    button('返回预览').click(); await tick();
    expect(button(/^待办/).classList.contains('tab-active')).toBe(true);
  });

  it('全部待办隐藏未打开文件的系统归档标题，保留同名用户子章节', async () => {
    await start(['- [ ] 当前任务\n', '# 归档\n\n- [ ] 待恢复任务\n\n## 归档\n\n- [ ] 用户章节任务\n']);
    button(/全部待办/).click(); await tick();
    await vi.waitFor(() => expect(document.querySelectorAll('.aggregate-task')).toHaveLength(3));
    const group = [...document.querySelectorAll('.aggregate-group')].find(node => node.querySelector('h2')?.textContent?.includes(secondProject.name))!;
    expect([...group.querySelectorAll('.aggregate-section-heading, .aggregate-title')].map(node => node.textContent)).toEqual(['待恢复任务', '归档', '用户章节任务']);
    expect(group.querySelector('.aggregate-task')?.classList.contains('aggregate-section-task')).toBe(false);
  });

  it('全部待办渲染组合 Markdown 和文档引用，点击样式文字仍定位原文', async () => {
    const source = '# 清单\n\n- [ ] **粗体与 *斜体*** ~~删除~~ `代码` [链接][ref] $x^2$ ![示意](./image.png)\n\n[ref]: https://example.com\n';
    await start([source]);
    button(/全部待办/).click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('.aggregate-task strong')?.textContent).toBe('粗体与 斜体'));
    const row = document.querySelector<HTMLButtonElement>('.aggregate-task')!;
    expect(row.querySelector('strong em')?.textContent).toBe('斜体');
    expect(row.querySelector('del')?.textContent).toBe('删除');
    expect(row.querySelector('code')?.textContent).toBe('代码');
    expect(row.querySelector('.fm-link')?.textContent).toBe('链接');
    expect(row.querySelector('.katex')).not.toBeNull();
    expect(row.querySelector('img')?.getAttribute('src')).toBe('/浏览器/image.png');
    expect(row.querySelector('a, button, input')).toBeNull();
    row.querySelector('em')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await tick();
    await vi.waitFor(() => expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(firstProject.name));
    expect((await files.read(firstProject.path)).text).toBe(source);
  });
  it('聚合标题限制在首行，转义 HTML 且不激活危险链接和图片', async () => {
    await start(['- [ ] [首行\n  后续正文](https://example.com)\n- [ ] <img src=x onerror=alert(1)> [危险](javascript:alert) ![危险图片](javascript:alert)\n']);
    button(/全部待办/).click(); await tick();
    await vi.waitFor(() => expect(document.querySelectorAll('.aggregate-task')).toHaveLength(2));
    const titles = [...document.querySelectorAll('.aggregate-title')];
    expect(titles[0].textContent).toBe('首行');
    expect(titles[1].textContent).toContain('<img src=x onerror=alert(1)>');
    expect(titles[1].querySelector('img, a, script')).toBeNull();
  });

  it('勾选和文本输入实际保存，重启后从原文件恢复任务与归档', async () => {
    const original = '# 甲清单\n\n- [ ] 完成并重开\n- [ ] 持续编辑\n';
    await start([original]);
    button('完成任务').click(); await tick();
    const completed = '# 甲清单\n\n- [ ] 持续编辑\n\n# 归档\n\n- [x] 完成并重开\n';
    await savedText(firstProject, completed);

    await insertTask(); await paste('输入实际落盘');
    const finalText = '# 甲清单\n\n- [ ] 持续编辑\n\n- [ ] 输入实际落盘\n\n# 归档\n\n- [x] 完成并重开\n';
    await savedText(firstProject, finalText);
    await remount();
    expect(documentInput().textContent).toContain('输入实际落盘');
    button(/^归档/).click(); await tick();
    expect(documentInput().textContent).toContain('完成并重开');
    expect(document.querySelector('[role="checkbox"][aria-checked="true"]')).not.toBeNull();
    expect((await files.read(firstProject.path)).text).toBe(finalText);
  });

  it('打开旧布局和载入外部修改后，经保存器写回文末归档分区', async () => {
    await start(['- [x] 历史完成\n- [ ] 保留待办\n']);
    const normalized = '- [ ] 保留待办\n\n# 归档\n\n- [x] 历史完成\n';
    await savedText(firstProject, normalized);
    const baseline = await files.read(firstProject.path);
    await files.write(firstProject.path, '- [x] 外部完成\n- [ ] 新待办\n', baseline.revision);
    window.dispatchEvent(new StorageEvent('storage', { key: `foldmark:file:${firstProject.path}` }));
    await savedText(firstProject, '- [ ] 新待办\n\n# 归档\n\n- [x] 外部完成\n');
    expect(documentInput().textContent).toContain('新待办');
  });

  it('从源码项目首次切入其他项目，归档整理仍经保存器落盘', async () => {
    await start(['- [ ] 源码项目\n', '- [x] 已完成\n- [ ] 待处理\n']);
    button('查看源码').click(); await tick();
    await switchProject(secondProject);
    await savedText(secondProject, '- [ ] 待处理\n\n# 归档\n\n- [x] 已完成\n');
  });

  it('从归档视图搜索待办，定位后输入仍落在待办原文', async () => {
    const source = '- [ ] 定位待办\n\n# 归档\n\n- [x] 完成任务\n';
    await start([source]);
    button(/^归档/).click(); await tick();
    button(/^搜索/).click(); await tick();
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索所有项目"]')!;
    search.value = '定位待办'; search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('.search-results')?.textContent).toContain('定位待办'));
    button(/待办.*定位待办/).click(); await tick();
    await vi.waitFor(() => expect(button(/^待办/).classList.contains('tab-active')).toBe(true));
    await paste('定位证据\n'); await shortcut('s');
    await savedText(firstProject, `定位证据\n${source}`);
  });

  it('保存前切换项目不丢草稿，撤销只影响当前项目', async () => {
    const first = '# 甲清单\n\n- [ ] 甲原始任务\n';
    const second = '# 乙清单\n\n- [ ] 乙原始任务\n';
    await start([first, second]);
    await insertTask(); await paste('甲的未保存草稿');
    await switchProject(secondProject);
    expect(documentInput().textContent).toContain('乙原始任务');
    expect(documentInput().textContent).not.toContain('甲的未保存草稿');
    await insertTask(); await paste('乙的未保存草稿');
    await shortcut('z');
    expect(documentInput().textContent).not.toContain('乙的未保存草稿');
    await shortcut('s');
    await savedText(secondProject, `${second}- [ ] `);

    await switchProject(firstProject);
    expect(documentInput().textContent).toContain('甲的未保存草稿');
    await shortcut('z'); await shortcut('s');
    await savedText(firstProject, `${first}- [ ] `);
    expect((await files.read(secondProject.path)).text).toBe(`${second}- [ ] `);
    await switchProject(secondProject);
    expect(documentInput().textContent).toContain('乙原始任务');
    expect(documentInput().textContent).not.toContain('甲原始任务');
  });

  it('跨项目搜索定位可展开已持久化折叠，搜索默认排除归档', async () => {
    const first = '# 甲清单\n\n- [ ] 甲任务\n';
    const second = '# 乙章节\n\n- [ ] 父任务\n  - [ ] 独特检索目标\n- [x] 独特归档目标\n';
    const folded = 'item:- [ ] 父任务\n  - [ ] 独特检索目标';
    await start([first, second], { [secondProject.id]: { mode: 'todo', cursor: 0, scrollTop: 0, folded: [folded] } });
    button(/^搜索/).click(); await tick();
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索所有项目"]')!;
    search.value = '独特'; search.dispatchEvent(new Event('input', { bubbles: true })); await tick();
    await vi.waitFor(() => expect(document.querySelector('.search-results')?.textContent).toContain('独特检索目标'));
    expect(document.querySelector('.search-results')?.textContent).not.toContain('独特归档目标');
    button(/待办.*独特检索目标/).click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(secondProject.name));
    expect(documentInput().textContent).toContain('独特检索目标');
    expect(document.querySelector('[aria-label="折叠条目"][aria-expanded="true"]')).not.toBeNull();
    expect(document.activeElement).toBe(documentInput());

    button(/^搜索/).click(); await tick();
    const include = [...document.querySelectorAll('label')].find(label => label.textContent?.includes('包含归档'))?.querySelector<HTMLInputElement>('input');
    expect(include).toBeDefined(); include!.click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('.search-results')?.textContent).toContain('独特归档目标'));
    button(/已完成.*独特归档目标/).click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('[role="checkbox"][aria-checked="true"]')).not.toBeNull());
    expect(documentInput().getAttribute('contenteditable')).toBe('false');
    expect(documentInput().textContent).toContain('独特归档目标');
  });
});


describe('项目操作失败与聚合视图边界', () => {
  it('恢复数据与正文无法保存时，移除关联仍保留唯一内存草稿', async () => {
    const original = '# 甲清单\n\n- [ ] 原始任务\n';
    await start([original]);
    vi.spyOn(BrowserFilePort.prototype, 'saveRecovery').mockRejectedValue(new Error('FILE_PERMISSION: 恢复目录不可写'));
    await insertTask(); await paste('只能保存在内存中的草稿');
    button('更多操作').click(); await tick(); button('移除项目关联').click(); await tick();
    button('删除项目').click();
    await new Promise(resolve => setTimeout(resolve, 0)); await tick();
    expect(documentInput().textContent).toContain('只能保存在内存中的草稿');
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].some(candidate => candidate.title === firstProject.path)).toBe(true);
    expect((await files.read(firstProject.path)).text).toBe(original);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('全部待办的菜单不提供针对隐藏项目的编辑操作', async () => {
    const original = '# 甲清单\n\n- [ ] 原始任务\n';
    await start([original]);
    button(/全部待办/).click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('.aggregate h1')?.textContent).toContain('全部待办'));
    button('更多操作').click(); await tick();
    const actions = [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim());
    expect(actions).not.toContain('新增任务');
    expect(actions).not.toContain('完成整组任务');
    expect(actions).not.toContain('同级上移');
    expect(actions).not.toContain('同级下移');
    expect((await files.read(firstProject.path)).text).toBe(original);
  });

  it('较早打开请求失败时，不覆盖后来已选中的项目', async () => {
    await start(['# 甲清单\n\n- [ ] 当前保留任务\n', '# 乙清单\n\n- [ ] 延迟读取任务\n']);
    const read = BrowserFilePort.prototype.read;
    let rejectEarlier!: (reason: Error) => void;
    vi.spyOn(BrowserFilePort.prototype, 'read').mockImplementation(function (this: BrowserFilePort, path: string) {
      if (path === secondProject.path) return new Promise((_resolve, reject) => { rejectEarlier = reject; });
      return read.call(this, path);
    });
    const pending = [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.title === secondProject.path)!;
    pending.click(); await tick();
    await switchProject(firstProject);
    rejectEarlier(new Error('FILE_NOT_FOUND: 过期的项目读取失败'));
    await new Promise(resolve => setTimeout(resolve, 0)); await tick();
    expect(document.querySelector('.breadcrumb strong')?.textContent).toBe(firstProject.name);
    expect(documentInput().textContent).toContain('当前保留任务');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('跨项目反馈和搜索范围', () => {
  it('旧项目的完成反馈不能撤销当前项目自己的编辑', async () => {
    const first = '# 甲清单\n\n- [ ] 完成甲任务\n';
    const second = '# 乙清单\n\n- [ ] 保留乙任务\n';
    await start([first, second]);
    await switchProject(secondProject);
    await insertTask(); await paste('乙项目必须保留的编辑');
    await shortcut('s');
    const savedSecond = `${second}- [ ] 乙项目必须保留的编辑`;
    await savedText(secondProject, savedSecond);
    await switchProject(firstProject);
    button('完成任务').click(); await tick();
    await switchProject(secondProject);
    const undo = [...document.querySelectorAll<HTMLButtonElement>('.toast button')].find(candidate => candidate.textContent?.trim() === '撤销');
    undo?.click(); await tick(); await shortcut('s');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await files.read(secondProject.path)).text).toBe(savedSecond);
  });

  it('在全部待办中打开全局搜索时，包含归档仍可检索已完成任务', async () => {
    await start(['# 甲清单\n\n- [ ] 普通待办\n- [x] 聚合页归档目标\n']);
    button(/全部待办/).click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('.aggregate h1')?.textContent).toContain('全部待办'));
    button(/^搜索/).click(); await tick();
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索所有项目"]')!;
    search.value = '聚合页归档目标'; search.dispatchEvent(new Event('input', { bubbles: true }));
    const include = [...document.querySelectorAll('label')].find(label => label.textContent?.includes('包含归档'))!.querySelector<HTMLInputElement>('input')!;
    include.click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('.search-results')?.textContent).toContain('聚合页归档目标'), { timeout: 3000 });
  });
});


describe('完整搜索结果、失效路径和退出保存', () => {
  it('损坏配置不会因初始化失败而被默认配置覆盖', async () => {
    const raw = '{ this is invalid config'; localStorage.setItem('foldmark:config', raw);
    const writes = vi.spyOn(BrowserFilePort.prototype, 'saveConfig');
    mounted = mount(App, { target: container }); await tick();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(writes).not.toHaveBeenCalled(); expect(localStorage.getItem('foldmark:config')).toBe(raw);
  });

  it('损坏恢复数据不会阻止完好的原文件打开，并保留独立提示', async () => {
    vi.spyOn(BrowserFilePort.prototype, 'loadRecovery').mockRejectedValue(new Error('RECOVERY_INVALID: 原恢复文件已保留备份'));
    await start(['# 完好原文件\n\n- [ ] 仍然可以查看\n']);
    expect(documentInput().textContent).toContain('仍然可以查看');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('RECOVERY_INVALID');
    await shortcut('s');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('RECOVERY_INVALID');
  });

  it.each(['暂不恢复', '点击外部'])('%s后正常保存和重新打开仍可找到草稿', async dismissal => {
    await start(['# 原文件\n\n- [ ] 磁盘内容\n']);
    const disk = await files.read(firstProject.path);
    const draft = { path: firstProject.path, text: '# 未保存的恢复内容\n', baseRevision: disk.revision, savedAt: Date.now() };
    await files.saveRecovery(draft); await remount();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    if (dismissal === '暂不恢复') button('暂不恢复').click();
    else document.querySelector<HTMLElement>('.modal-backdrop')!.click();
    await tick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await shortcut('s');
    expect((await files.loadRecovery(firstProject.path))?.text).toBe(draft.text);
    await remount();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('未写入文件的草稿');
  });

  it('旧布局存在待确认草稿时，不自动整理覆盖恢复文件', async () => {
    const source = '- [x] 尚未分区的完成任务\n- [ ] 待办\n';
    await files.create(firstProject.path, source);
    const disk = await files.read(firstProject.path);
    const draft = { path: firstProject.path, text: '- [ ] 唯一恢复内容\n', baseRevision: disk.revision, savedAt: Date.now() };
    await files.saveRecovery(draft);
    await files.saveConfig({ projects: [firstProject], activeProjectId: firstProject.id, preferences: { ...defaultPreferences }, projectViews: {} });
    await remount();
    button('暂不恢复').click(); await tick(); await shortcut('s');
    expect((await files.read(firstProject.path)).text).toBe(source);
    expect((await files.loadRecovery(firstProject.path))?.text).toBe(draft.text);
  });

  it('选用磁盘版本后切换项目及源码视图，仍保留被替换的恢复草稿', async () => {
    await start(['- [ ] 原始任务\n', '- [ ] 第二项目\n']);
    await paste('本地草稿\n');
    const baseline = await files.read(firstProject.path);
    const external = '- [x] 外部完成\n- [ ] 外部待办\n';
    await files.write(firstProject.path, external, baseline.revision);
    window.dispatchEvent(new StorageEvent('storage', { key: `foldmark:file:${firstProject.path}` }));
    await vi.waitFor(() => expect(document.querySelector('.conflict-banner')).not.toBeNull());
    button('比较并处理').click(); await tick();
    document.querySelector<HTMLElement>('.modal-backdrop')!.click(); await tick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('.conflict-banner')).not.toBeNull();
    expect(documentInput().textContent).toContain('本地草稿');
    expect((await files.read(firstProject.path)).text).toBe(external);
    button('比较并处理').click(); await tick();
    button('选用磁盘版本').click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    const recoveryText = (await files.loadRecovery(firstProject.path))?.text;
    expect(recoveryText).toContain('本地草稿');
    await switchProject(secondProject); await switchProject(firstProject);
    button('查看源码').click(); await tick();
    button(/^待办/).click(); await tick(); await shortcut('s');
    expect((await files.read(firstProject.path)).text).toBe(external);
    expect((await files.loadRecovery(firstProject.path))?.text).toBe(recoveryText);
  });

  it('超过一百条同类搜索结果可继续加载并定位到末项原文', async () => {
    const original = '# 大清单\n\n' + Array.from({ length: 105 }, (_, index) => `- [ ] 同类检索任务 ${index+1}\n`).join('');
    await start([original]);
    button(/^搜索/).click(); await tick();
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索所有项目"]')!;
    search.value = '同类检索任务'; search.dispatchEvent(new Event('input', { bubbles: true })); await tick();
    await vi.waitFor(() => expect(document.querySelectorAll('.search-result')).toHaveLength(100));
    expect(document.querySelector('.search-results')?.textContent).not.toContain('同类检索任务 105');
    button(/显示更多/).click(); await tick();
    expect(document.querySelectorAll('.search-result')).toHaveLength(105);
    button(/待办.*同类检索任务 105/).click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="跨项目搜索"]')).toBeNull());
    await paste('定位证据\n'); await shortcut('s');
    const target = original.indexOf('- [ ] 同类检索任务 105');
    await savedText(firstProject, original.slice(0,target)+'定位证据\n'+original.slice(target));
  });

  it('原路径失效后重新定位保留本地草稿，并在比较确认后写入新文件', async () => {
    const original = '# 原清单\n\n- [ ] 旧任务\n';
    const destination = '# 新文件\n\n- [ ] 新文件自己的任务\n';
    await start([original]);
    await files.create(secondProject.path,destination);
    vi.spyOn(BrowserFilePort.prototype,'chooseFile').mockResolvedValue(secondProject.path);
    await insertTask(); await paste('迁移时不能丢的草稿');
    const draft = `${original}- [ ] 迁移时不能丢的草稿`;
    localStorage.removeItem(`foldmark:file:${firstProject.path}`);
    await shortcut('s');
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('FILE_NOT_FOUND'));
    button('重新定位文件').click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('未写入文件的草稿'));
    const versions = [...document.querySelectorAll<HTMLTextAreaElement>('[role="dialog"] textarea')].map(field=>field.value);
    expect(versions).toEqual([draft,destination]);
    expect((await files.read(secondProject.path)).text).toBe(destination);
    expect((await files.loadRecovery(secondProject.path))?.text).toBe(draft);
    button('恢复草稿继续编辑').click(); await tick(); await shortcut('s');
    await savedText({ ...firstProject,path:secondProject.path },draft);
    await expect(files.read(firstProject.path)).rejects.toThrow('FILE_NOT_FOUND');
    await vi.waitFor(async () => expect((await files.loadConfig())?.projects[0].path).toBe(secondProject.path));
  });

  it('正文保存成功但配置保存失败时阻止桌面窗口退出，重试成功才销毁', async () => {
    desktopBoundary.enabled = true;
    await start(['# 甲清单\n\n- [ ] 保留项目关联\n']);
    await vi.waitFor(() => expect(desktopBoundary.close).not.toBeNull());
    const saveConfig = vi.spyOn(BrowserFilePort.prototype,'saveConfig').mockRejectedValue(new Error('FILE_PERMISSION: 配置目录不可写'));
    const preventDefault = vi.fn();
    await desktopBoundary.close!({ preventDefault }); await tick();
    expect(preventDefault).toHaveBeenCalled();
    expect(desktopBoundary.destroy).not.toHaveBeenCalled();
    expect(documentInput().textContent).toContain('保留项目关联');
    saveConfig.mockRestore();
    await desktopBoundary.close!({ preventDefault });
    expect(desktopBoundary.destroy).toHaveBeenCalledTimes(1);
  });
});
