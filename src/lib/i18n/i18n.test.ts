/** 文件职责：验证语言回退、响应式通知及插值隔离。 */
import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createTranslator, locale, resolveLocale, setLocalePreference, t, translate } from './index';
import { appMessages } from './app-messages';
import { coreMessages } from './core-messages';
import { editorMessages } from './editor-messages';
import { platformMessages } from './platform-messages';

afterEach(() => setLocalePreference('zh-CN'));
describe('界面语言', () => {
  it('各词典保留完整插值参数且共享原文没有互相覆盖的译文', () => {
    const seen = new Map<string, string>();
    const parameters = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const dictionary of [appMessages, coreMessages, editorMessages, platformMessages]) {
      for (const [source, translation] of Object.entries(dictionary)) {
        expect(translation.trim(), source).not.toBe('');
        expect(parameters(translation), source).toEqual(parameters(source));
        if (seen.has(source)) expect(translation, source).toBe(seen.get(source));
        seen.set(source, translation);
      }
    }
  });
  it('旧配置保留中文，系统偏好匹配受支持语言并回退英文', () => {
    expect(resolveLocale(undefined, ['en-US'])).toBe('zh-CN');
    expect(resolveLocale('future-language')).toBe('zh-CN');
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveLocale('system', ['zh-TW', 'en-US'])).toBe('zh-CN');
    expect(resolveLocale('system', ['fr-FR', 'en-GB'])).toBe('en');
    expect(resolveLocale('system', ['ja-JP'])).toBe('en');
  });
  it('组件与命令翻译同步切换，更新文档语言', () => {
    setLocalePreference('en');
    expect(get(locale)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(get(t)('语言')).toBe('Language');
    expect(translate('语言')).toBe('Language');
    setLocalePreference('zh-CN');
    expect(get(t)('语言')).toBe('语言');
    expect(document.documentElement.lang).toBe('zh-CN');
  });
  it('未知文案回退且不递归解释用户参数或原型属性', () => {
    const tr = createTranslator('en');
    expect(tr('未知文案')).toBe('未知文案');
    expect(tr('{name} {count}', { name: '{count}', count: 2 })).toBe('{count} 2');
    expect(tr('{missing}')).toBe('{missing}');
    expect(tr('constructor')).toBe('constructor');
    expect(tr('{constructor}', {})).toBe('{constructor}');
  });
  it('系统语言变化只影响跟随系统偏好', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'languages');
    try {
      Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US'] });
      setLocalePreference('system');
      expect(get(locale)).toBe('en');
      Object.defineProperty(navigator, 'languages', { configurable: true, value: ['zh-CN'] });
      window.dispatchEvent(new Event('languagechange'));
      expect(get(locale)).toBe('zh-CN');
      setLocalePreference('en');
      window.dispatchEvent(new Event('languagechange'));
      expect(get(locale)).toBe('en');
    } finally {
      if (original) Object.defineProperty(navigator, 'languages', original);
      else Reflect.deleteProperty(navigator, 'languages');
    }
  });
});
