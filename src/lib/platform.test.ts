import { expect, it } from 'vitest';
import { platformCapabilities } from './platform';
it('Android 原生环境不具备桌面窗口能力', () => {
  expect(platformCapabilities(true, 'Android 15')).toEqual({ native: true, android: true, desktop: false });
  expect(platformCapabilities(true, 'Windows')).toEqual({ native: true, android: false, desktop: true });
  expect(platformCapabilities(false, 'Android')).toEqual({ native: false, android: false, desktop: false });
});
