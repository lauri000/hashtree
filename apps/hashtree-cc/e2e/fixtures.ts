import { expect, test as base } from '@playwright/test';
import { attachRenderLoopGuardToContext, formatRenderLoopFailures } from './renderLoopGuard';

type Fixtures = {
  renderLoopFailures: Set<string>;
};

export const test = base.extend<Fixtures>({
  renderLoopFailures: async ({}, use) => {
    const failures = new Set<string>();
    await use(failures);
    expect(
      failures.size,
      failures.size > 0 ? formatRenderLoopFailures(failures) : undefined
    ).toBe(0);
  },

  page: async ({ page, renderLoopFailures }, use) => {
    attachRenderLoopGuardToContext(page.context(), renderLoopFailures);
    await use(page);
  },
});

export { expect };
