/**
 * 文件职责：通过公开 DOM 和浏览器文件端口验证真实 App 的编辑保存闭环。
 * 定义范围：任务完成、文本输入、重启、项目历史隔离及跨项目搜索定位。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import App from '../../App.svelte';
import { BrowserFilePort, defaultPreferences } from '../browser-files';
import type { AppConfig, Project, ProjectView } from '../contracts';

const desktopBoundary = vi.hoisted(() => ({
  enabled: false,
  close: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
  destroy: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => desktopBoundary.enabled, convertFileSrc: (path: string) => path }));
// 仅替换桌面 IO 与窗口事件边界，退出决策仍运行生产 App 代码。
vi.mock('../files/tauri', async () => {
  const { BrowserFilePort } = await import('../browser-files');
  return { TauriFilePort: BrowserFilePort, openExternalLink: vi.fn(async () => {}) };
});
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  onCloseRequested: async (callback: (event: { preventDefault: () => void }) => Promise<void>) => {
    desktopBoundary.close = callback;
    return () => { desktopBoundary.close = null; };
  },
  destroy: desktopBoundary.destroy,
}) }));

const files = new BrowserFilePort();
const firstProject: Project = { id: 'project-a', name: '甲项目', path: '浏览器/甲.md' };
const secondProject: Project = { id: 'project-b', name: '乙项目', path: '浏览器/乙.md' };
let mounted: ReturnType<typeof mount> | undefined;
let container: HTMLDivElement;

/** jsdom 没有排版引擎；只补充几何 API，不替换真实编辑器、保存器或 App 行为。 */
beforeEach(() => {
  desktopBoundary.enabled = false; desktopBoundary.close = null; desktopBoundary.destroy.mockClear();
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
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks();
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

/** 等待可从文件端口重新读取的正文，避免将仅有 DOM 变化误判为已保存。 */
async function savedText(project: Project, expected: string): Promise<void> {
  await vi.waitFor(async () => expect((await files.read(project.path)).text).toBe(expected), { timeout: 5000 });
}

describe('App 真实编辑与文件闭环', () => {
  it('勾选和文本输入实际保存，重启后从原文件恢复任务与归档', async () => {
    const original = '# 甲清单\n\n- [ ] 完成并重开\n- [ ] 持续编辑\n';
    await start([original]);
    button('完成任务').click(); await tick();
    const completed = original.replace('[ ] 完成并重开', '[x] 完成并重开');
    await savedText(firstProject, completed);

    button('＋ 新任务').click(); await tick(); await paste('输入实际落盘');
    const finalText = `${completed}- [ ] 输入实际落盘`;
    await savedText(firstProject, finalText);
    await remount();
    expect(documentInput().textContent).toContain('输入实际落盘');
    button(/^归档/).click(); await tick();
    expect(documentInput().textContent).toContain('完成并重开');
    expect(document.querySelector('[role="checkbox"][aria-checked="true"]')).not.toBeNull();
    expect((await files.read(firstProject.path)).text).toBe(finalText);
  });

  it('保存前切换项目不丢草稿，撤销只影响当前项目', async () => {
    const first = '# 甲清单\n\n- [ ] 甲原始任务\n';
    const second = '# 乙清单\n\n- [ ] 乙原始任务\n';
    await start([first, second]);
    button('＋ 新任务').click(); await tick(); await paste('甲的未保存草稿');
    await switchProject(secondProject);
    expect(documentInput().textContent).toContain('乙原始任务');
    expect(documentInput().textContent).not.toContain('甲的未保存草稿');
    button('＋ 新任务').click(); await tick(); await paste('乙的未保存草稿');
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
    button('＋ 新任务').click(); await tick(); await paste('只能保存在内存中的草稿');
    button('更多操作').click(); await tick(); button('移除项目关联').click(); await tick();
    button('移除关联').click();
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
    button('＋ 新任务').click(); await tick(); await paste('乙项目必须保留的编辑');
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

  it('暂不恢复后正常保存和重新打开仍可找到草稿', async () => {
    await start(['# 原文件\n\n- [ ] 磁盘内容\n']);
    const disk = await files.read(firstProject.path);
    const draft = { path: firstProject.path, text: '# 未保存的恢复内容\n', baseRevision: disk.revision, savedAt: Date.now() };
    await files.saveRecovery(draft); await remount();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    button('暂不恢复').click(); await tick(); await shortcut('s');
    expect((await files.loadRecovery(firstProject.path))?.text).toBe(draft.text);
    await remount();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('未写入文件的草稿');
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
    button('＋ 新任务').click(); await tick(); await paste('迁移时不能丢的草稿');
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
