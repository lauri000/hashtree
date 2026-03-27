import { expect, test } from '@playwright/test';
import { formatRenderLoopFailures, isRenderLoopMessage } from './renderLoopGuard';

test('matches Svelte update-depth loop errors', async () => {
  expect(isRenderLoopMessage('effect_update_depth_exceeded\nMaximum update depth exceeded')).toBe(true);
  expect(isRenderLoopMessage('Maximum update depth exceeded')).toBe(true);
  expect(isRenderLoopMessage('Unhandled promise rejection')).toBe(false);
});

test('formats detected loop failures for test output', async () => {
  expect(formatRenderLoopFailures(new Set([
    '[pageerror] /#/ effect_update_depth_exceeded',
  ]))).toBe(
    'Detected Svelte render/update loop:\n[pageerror] /#/ effect_update_depth_exceeded'
  );
});
