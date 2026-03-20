import { test, expect } from './fixtures';
import { ensureLoggedIn, gotoGitApp, navigateToPublicFolder, setupPageErrorHandler } from './test-utils.js';

async function createTopLevelRepository(page: import('@playwright/test').Page, repoName: string) {
  await page.getByRole('button', { name: /New Repository/ }).first().click();
  await page.getByPlaceholder('Repository name...').fill(repoName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(new RegExp(`/git\\.html#\\/npub.*\\/${repoName}`), { timeout: 30000 });
}

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
    await ensureLoggedIn(page);

    const repoName = `git-actions-${Date.now()}`;
    await createTopLevelRepository(page, repoName);

    await expect(page.getByRole('button', { name: /commits/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Document' })).not.toBeVisible();
  });

  test('git app home lists repositories instead of the generic folder browser', async ({ page }) => {
    setupPageErrorHandler(page);
    await gotoGitApp(page);
    await ensureLoggedIn(page);

    const repoName = `git-home-${Date.now()}`;

    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
    await expect(page.getByText('Add files to begin')).not.toBeVisible();

    await createTopLevelRepository(page, repoName);

    await gotoGitApp(page);

    await expect(page.getByRole('link', { name: new RegExp(repoName) })).toBeVisible({ timeout: 15000 });
  });
});
