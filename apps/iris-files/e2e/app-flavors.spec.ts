import { test, expect } from './fixtures';
import { gotoGitApp, navigateToPublicFolder, setupPageErrorHandler } from './test-utils.js';

test.describe('App flavors', () => {
  test('files app hides git and document actions', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await navigateToPublicFolder(page, { requireRelay: false });

    await expect(page.getByRole('button', { name: 'Git Init' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'New Document' })).not.toBeVisible();
  });

  test('git app exposes git actions without docs actions', async ({ page }) => {
    setupPageErrorHandler(page);
    await gotoGitApp(page);
    await navigateToPublicFolder(page, { requireRelay: false });

    await expect(page.getByRole('button', { name: 'New Repository' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Git Init' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Document' })).not.toBeVisible();
  });
});
