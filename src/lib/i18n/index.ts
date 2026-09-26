/**
 * 文件职责：提供界面语言解析与响应式翻译入口。
 * 定义范围：语言偏好、插值翻译、系统语言订阅；持久化由应用配置层负责。
 */
import { derived, readonly, writable } from 'svelte/store';
import { coreMessages } from './core-messages';
import { appMessages } from './app-messages';
import { editorMessages } from './editor-messages';
import { platformMessages } from './platform-messages';

/** 结构职责：标识受支持界面语言；约束条件：不表示 Markdown 正文的语言。 */
export type Locale = 'zh-CN' | 'en';
/** 结构职责：保存用户语言选择；约束条件：旧配置缺省为简体中文，system 在运行时解析。 */
export type LocalePreference = Locale | 'system';
/** 接口职责：翻译界面文案并执行具名插值；调用方：组件和平台适配层；实现要求：缺失译文回退原文，参数不再解释为模板。 */
export type Translator = (source: string, parameters?: Record<string, string | number>) => string;

/**
 * 函数职责：从偏好和系统语言列表解析受支持语言。
 * 输入说明：缺失或未知偏好视为旧配置，系统列表按首选顺序提供。
 * 输出说明：返回稳定语言标识；不支持的系统语言回退英文。
 * 实现思路：显式语言优先；system 匹配首选受支持语言。
 */
export function resolveLocale(preference: unknown, languages: readonly string[] = []): Locale {
  if (preference === 'en') return 'en';
  if (preference !== 'system') return 'zh-CN';
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(language)) return 'en';
  }
  return 'en';
}
/**
 * 函数职责：为明确语言生成翻译函数。
 * 输入说明：语言已经解析，原文仅来自应用界面。
 * 输出说明：返回无副作用翻译函数；未提供的插值保留占位符。
 * 实现思路：查找语言字典后一次性替换具名参数。
 */
export function createTranslator(language: Locale): Translator {
  return (source, parameters = {}) => {
    const template = language === 'en' && Object.hasOwn(messages, source) ? messages[source] : source;
    // 单次替换确保文件名等用户值中的花括号不会被二次当成翻译模板。
    return template.replace(/\{(\w+)\}/g, (token, name: string) => Object.hasOwn(parameters, name) ? String(parameters[name]) : token);
  };
}
/** 函数职责：更新当前语言偏好；输入说明：由配置恢复或设置选择调用；输出说明：发布语言及 HTML lang；实现思路：解析系统偏好后通知订阅者。 */
export function setLocalePreference(preference: LocalePreference): void {
  currentPreference = preference;
  currentLocale = resolveLocale(preference, typeof navigator === 'undefined' ? [] : navigator.languages);
  if (typeof document !== 'undefined') document.documentElement.lang = currentLocale;
  languageStore.set(currentLocale);
}
/** 函数职责：翻译调用时语言下的界面文案；输入说明：不得传入用户正文；输出说明：插值后的文本；实现思路：委托当前语言翻译器。 */
export const translate: Translator = (source, parameters) => createTranslator(currentLocale)(source, parameters);

const messages: Record<string, string> = { ...coreMessages, ...appMessages, ...editorMessages, ...platformMessages };
let currentPreference: LocalePreference = 'zh-CN';
let currentLocale: Locale = 'zh-CN';
const languageStore = writable<Locale>(currentLocale);
export const locale = readonly(languageStore);
export const t = derived(locale, createTranslator);

// 应用级订阅与模块同寿命，热更新时移除旧监听，避免累积处理器。
if (typeof window !== 'undefined') {
  const handleLanguageChange = () => { if (currentPreference === 'system') setLocalePreference('system'); };
  window.addEventListener('languagechange', handleLanguageChange);
  import.meta.hot?.dispose(() => window.removeEventListener('languagechange', handleLanguageChange));
}
