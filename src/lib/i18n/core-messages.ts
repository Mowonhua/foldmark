/**
 * 文件职责：提供配置与主题边界错误的英文文案。
 * 定义范围：应用自有界面文本；不翻译第三方主题名称或用户文档。
 */
export const coreMessages: Record<string, string> = {
  '语言': 'Language',
  '恢复窗口状态失败': 'Could not restore the window state',
  '进入卡片模式失败，窗口恢复需要重试': 'Could not enter card mode. Retry to restore the window.',
  '视觉参数需使用支持的颜色、尺寸、字重、完成标记或最多四层的像素阴影。': 'Appearance parameters must use supported colors, sizes, font weights, completion markers, or pixel shadows with up to four layers.',
  '项目配置格式无效，原配置已保留，请修复配置后重新打开应用。': 'The project configuration is invalid. The original configuration has been preserved. Repair it and reopen the app.',
  '主题需包含 version: 1、唯一 id、名称及完整的浅色和深色六位十六进制配色。': 'A theme must include version: 1, a unique id, a name, and complete light and dark palettes with six-digit hex colors.',
  '主题文件不能超过 64 KiB。': 'Theme files must not exceed 64 KiB.',
  '主题文件不是有效的 JSON。': 'The theme file is not valid JSON.',
};
