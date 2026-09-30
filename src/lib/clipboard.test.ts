/**
 * 文件职责：验证跨平台纯文本剪贴板端口的环境边界和错误契约。
 * 定义范围：原始文本保留、平台路由与拒绝访问行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboard } from './clipboard';

const desktop = vi.hoisted(() => ({
  enabled: false,
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => desktop.enabled }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: desktop.readText,
  writeText: desktop.writeText,
}));

const browserRead = vi.fn<() => Promise<string>>();
const browserWrite = vi.fn<(text: string) => Promise<void>>();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  vi.resetAllMocks();
  desktop.enabled = false;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: browserRead, writeText: browserWrite },
  });
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('正文纯文本剪贴板', () => {
  it('浏览器读写保留中文、Markdown 和原始换行', async () => {
    const text = '**正文**\r\n第二行\n';
    browserRead.mockResolvedValue(text);
    await expect(clipboard.readText()).resolves.toBe(text);
    await expect(clipboard.writeText(text)).resolves.toBeUndefined();
    expect(browserWrite).toHaveBeenCalledWith(text);
    expect(desktop.readText).not.toHaveBeenCalled();
    expect(desktop.writeText).not.toHaveBeenCalled();
  });

  it('桌面即使没有浏览器剪贴板仍能读写空文本', async () => {
    desktop.enabled = true;
    Reflect.deleteProperty(navigator, 'clipboard');
    desktop.readText.mockResolvedValue('');
    await expect(clipboard.readText()).resolves.toBe('');
    await expect(clipboard.writeText('')).resolves.toBeUndefined();
    expect(desktop.writeText).toHaveBeenCalledWith('');
    expect(browserRead).not.toHaveBeenCalled();
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it('浏览器缺少 Clipboard API 时读写均拒绝', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    await expect(clipboard.readText()).rejects.toThrow();
    await expect(clipboard.writeText('正文')).rejects.toThrow();
  });

  it('浏览器访问被拒绝时传播原始异常', async () => {
    const error = new DOMException('Clipboard denied', 'NotAllowedError');
    browserRead.mockRejectedValue(error);
    browserWrite.mockRejectedValue(error);
    await expect(clipboard.readText()).rejects.toBe(error);
    await expect(clipboard.writeText('正文')).rejects.toBe(error);
  });

  it('原生插件失败时传播异常并保持单一平台边界', async () => {
    desktop.enabled = true;
    const error = new Error('Native clipboard unavailable');
    desktop.readText.mockRejectedValue(error);
    desktop.writeText.mockRejectedValue(error);
    await expect(clipboard.readText()).rejects.toBe(error);
    await expect(clipboard.writeText('正文')).rejects.toBe(error);
    expect(browserRead).not.toHaveBeenCalled();
    expect(browserWrite).not.toHaveBeenCalled();
  });
});
