import { test, expect } from './fixtures';
import {
  createFolder,
  ensureLoggedIn,
  flushPendingPublishes,
  goToTreeList,
  gotoGitApp,
  loginAsTestUser,
  navigateToPublicFolder,
  setupPageErrorHandler,
  waitForRelayConnected,
} from './test-utils.js';

const SOURCE_CODE_LINK_NAME = /hashtree.*source code/i;

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

    await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible();
    await expect(page.getByText('Add files to begin')).not.toBeVisible();

    await createTopLevelRepository(page, repoName);

    await gotoGitApp(page);

    await expect(page.getByRole('link', { name: new RegExp(repoName) })).toBeVisible({ timeout: 15000 });
  });

  test('git app profile route shows repositories instead of the generic tree sidebar', async ({ page }) => {
    setupPageErrorHandler(page);

    await page.goto('/');
    await ensureLoggedIn(page);
    await goToTreeList(page);

    const plainTreeName = `plain-tree-${Date.now()}`;
    await createFolder(page, plainTreeName);
    await flushPendingPublishes(page);

    const npub = await page.evaluate(() => (window as { __nostrStore?: { getState?: () => { npub?: string } } }).__nostrStore?.getState?.().npub ?? null);
    const nsec = await page.evaluate(() => window.localStorage.getItem('hashtree:nsec'));
    expect(npub).toBeTruthy();
    expect(nsec).toBeTruthy();

    await gotoGitApp(page);
    await loginAsTestUser(page, nsec);
    await waitForRelayConnected(page);

    const repoName = `git-profile-${Date.now()}`;
    await createTopLevelRepository(page, repoName);
    await flushPendingPublishes(page);

    await page.goto(`/git.html#/${npub}`);

    await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(repoName) })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Repository', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: new RegExp(plainTreeName) })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'New Folder' })).not.toBeVisible();
    await expect(page.getByText('Add files to begin')).not.toBeVisible();
  });

  test('source code link stays in-tab on git and opens a new tab on other flavors', async ({ page }) => {
    setupPageErrorHandler(page);

    await page.goto('/git.html#/settings/app');
    await expect(page.getByRole('button', { name: 'App', exact: true })).toBeVisible({ timeout: 10000 });
    const gitSourceLink = page.getByRole('link', { name: SOURCE_CODE_LINK_NAME }).first();
    await expect(gitSourceLink).toBeVisible({ timeout: 10000 });
    await expect(gitSourceLink).toHaveAttribute('href', /hashtree$/);
    await expect(gitSourceLink).not.toHaveAttribute('target', '_blank');

    await page.goto('/#/settings/app');
    await expect(page.getByRole('button', { name: 'App', exact: true })).toBeVisible({ timeout: 10000 });
    const filesSourceLink = page.getByRole('link', { name: SOURCE_CODE_LINK_NAME }).first();
    await expect(filesSourceLink).toBeVisible({ timeout: 10000 });
    await expect(filesSourceLink).toHaveAttribute('href', /hashtree$/);
    await expect(filesSourceLink).toHaveAttribute('target', '_blank');
  });
});
