/**
 * 文件职责：定义主题包的通用视觉参数及其 CSS 变量边界。
 * 定义范围：视觉参数白名单、值校验和完整覆盖；不识别主题名称或风格。
 */

// 参数描述同时约束导入字段和根节点变量，防止两处白名单漂移。
export const appearanceProperties = {
  'control-shadow': 'shadow',
  'control-pressed-shadow': 'shadow',
  'field-shadow': 'shadow',
  'nav-active-shadow': 'shadow',
  'tabs-shadow': 'shadow',
  'tab-active-shadow': 'shadow',
  'floating-shadow': 'shadow',
  // 编辑器任务控件与聚合列表标记共用外观，不影响表单中的原生复选框。
  'task-checkbox-shadow': 'shadow',
  'task-checkbox-checked-shadow': 'shadow',
  'task-checkbox-border': 'color',
  'task-checkbox-checked-background': 'color',
  'task-checkbox-checked-color': 'color',
  'task-checkbox-checked-mark': 'symbol',
  'task-checkbox-checked-mark-size': 'length',
  'task-checkbox-checked-mark-width': 'length',
  'task-checkbox-checked-mark-height': 'length',
  'task-checkbox-checked-mark-radius': 'length',
  'task-checkbox-checked-mark-background': 'color',
  'task-checkbox-checked-mark-shadow': 'shadow',
  'control-radius': 'length',
  'field-radius': 'length',
  'nav-radius': 'length',
  'tabs-radius': 'length',
  'tab-radius': 'length',
  'floating-radius': 'length',
  'tabs-padding': 'length',
  'tabs-gap': 'length',
  'tab-active-weight': 'weight',
  'control-background': 'color',
  'control-border': 'color',
  'field-border': 'color',
  'nav-active-background': 'color',
  'tabs-background': 'color',
  'tab-active-background': 'color',
  'divider-color': 'color',
  'floating-border': 'color',
} as const;

/**
 * 结构职责：承载一种明暗模式下的可选视觉参数。
 * 字段说明：length 为像素数值，weight 为字重；color 为实色或透明，shadow 为有限层阴影，symbol 为完成字符或用于几何标记的空字符串。
 * 约束条件：缺省键由组件 CSS 回退；不接受选择器、资源地址或任意 CSS 表达式。
 */
export type ThemeAppearance = {
  [Key in keyof typeof appearanceProperties]?: typeof appearanceProperties[Key] extends 'length' | 'weight' ? number : string;
};

/**
 * 函数职责：校验一套视觉参数并返回只包含白名单字段的副本。
 * 输入说明：来自主题 JSON 的单个明暗模式，必须是对象。
 * 输出说明：非法已知字段抛 THEME_INVALID；未知字段忽略。
 * 实现思路：按参数类别限制数值范围与字符串语法，阴影最多四层。
 */
export function validateAppearance(value: unknown): ThemeAppearance {
  const fail = (): never => { throw new Error('THEME_INVALID: 视觉参数需使用支持的颜色、尺寸、字重、完成标记或最多四层的像素阴影。'); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail();
  const source = value as Record<string, unknown>;
  const result: Record<string, string | number> = {};
  for (const [key, kind] of Object.entries(appearanceProperties)) {
    if (!Object.hasOwn(source, key)) continue;
    const entry = source[key];
    if (kind === 'length' || kind === 'weight') {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) return fail();
      if (kind === 'length' && (entry < 0 || entry > 32)) return fail();
      if (kind === 'weight' && (!Number.isInteger(entry) || entry < 100 || entry > 900)) return fail();
    } else {
      if (typeof entry !== 'string') return fail();
      if (kind === 'color' && !/^(#[0-9a-f]{6}|transparent)$/i.test(entry)) return fail();
      if (kind === 'symbol' && entry !== '' && entry !== '✓' && entry !== '●') return fail();
      if (kind === 'shadow' && entry !== 'none') {
        // 阴影仅允许偏移为负数，模糊半径非负；禁用变量、函数和其他 CSS 语法。
        const layers = entry.split(',');
        if (entry.length > 512 || layers.length > 4 || layers.some(layer => !/^(?:inset )?-?(?:0|[1-9]\d?)px -?(?:0|[1-9]\d?)px (?:0|[1-9]\d?)px #[0-9a-f]{6}$/i.test(layer.trim()))) return fail();
      }
    }
    result[key] = entry;
  }
  return result as ThemeAppearance;
}

/**
 * 函数职责：覆盖根节点上的全部通用视觉参数。
 * 输入说明：appearance 已通过校验；undefined 表示恢复组件默认视觉参数。
 * 输出说明：写入当前参数并移除缺省键，不保留上一主题或模式的值。
 * 实现思路：仅遍历白名单，尺寸转换为 px，完成标记编码为 CSS 字符串，其余值直接写入。
 */
export function applyAppearance(root: HTMLElement, appearance?: ThemeAppearance): void {
  // 持久化配置可能保留未知字段，不能按输入对象的键枚举 CSS 变量。
  for (const key of Object.keys(appearanceProperties) as (keyof ThemeAppearance)[]) {
    const value = appearance && Object.hasOwn(appearance, key) ? appearance[key] : undefined;
    if (value === undefined) root.style.removeProperty(`--${key}`);
    // 标记只允许受支持字符或空串；空串仍生成伪元素，供尺寸与背景参数绘制几何标记。
    else if (appearanceProperties[key] === 'symbol') root.style.setProperty(`--${key}`, JSON.stringify(value));
    else root.style.setProperty(`--${key}`, appearanceProperties[key] === 'length' ? `${value}px` : String(value));
  }
}
