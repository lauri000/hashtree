import { test, expect } from './fixtures';
import { setupPageErrorHandler, navigateToPublicFolder, disableOthersPool, gotoGitApp } from './test-utils.js';

test.describe('Releases', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  test.describe.configure({ timeout: 90000 });

  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await gotoGitApp(page);
    await disableOthersPool(page);
  });

  test('create, edit, and delete a release', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000 });

    const route = await page.evaluate(() => {
      const hash = window.location.hash.slice(1);
      const qIdx = hash.indexOf('?');
      const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
      const parts = path.split('/').filter(Boolean);
      return { npub: parts[0], treeName: parts[1] };
    });

    await page.goto(`/git.html#/${route.npub}/${route.treeName}?tab=releases`);
    await expect(page.locator('text=Loading releases...')).not.toBeVisible({ timeout: 20000 });
    await expect(page.locator('text=No releases yet')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('repo-header-row')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Release' })).toBeVisible();

    await page.getByRole('button', { name: 'New Release' }).click();
    await page.locator('#release-title').fill('Iris Files v0.1');
    await page.locator('#release-tag').fill('v0.1.0');
    await page.locator('#release-commit').fill('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    await page.locator('#release-notes').fill('## Changes\n- initial release');

    const assetInput = page.locator('#release-assets');
    await assetInput.setInputFiles({
      name: 'artifact.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('artifact content'),
    });

    await page.getByRole('button', { name: 'Create Release' }).click();
    await expect(page.locator('a:has-text("Iris Files v0.1")')).toBeVisible({ timeout: 20000 });

    await page.locator('a:has-text("Iris Files v0.1")').click();
    await expect(page.locator('h1:has-text("Iris Files v0.1")')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('text=initial release')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('a:has-text("artifact.txt")')).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#release-title').fill('Iris Files v0.1.1');
    await page.locator('#release-notes').fill('## Changes\n- updated release');
    await page.getByRole('button', { name: 'Save Release' }).click();

    await expect(page.locator('h1:has-text("Iris Files v0.1.1")')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('text=updated release')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('a:has-text("artifact.txt")')).toBeVisible({ timeout: 20000 });

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete' }).click();

    await page.waitForURL(/tab=releases/, { timeout: 20000 });
    await expect(page.locator('text=No releases yet')).toBeVisible({ timeout: 20000 });
  });

  test('shows release summary in the repo sidebar', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000 });

    const route = await page.evaluate(() => {
      const hash = window.location.hash.slice(1);
      const qIdx = hash.indexOf('?');
      const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
      const parts = path.split('/').filter(Boolean);
      return { npub: parts[0], treeName: parts[1] };
    });

    const releaseTitle = `Sidebar Release ${Date.now()}`;
    const releaseTag = `v${Date.now()}`;

    await page.goto(`/git.html#/${route.npub}/${route.treeName}?tab=releases`);
    await expect(page.locator('text=Loading releases...')).not.toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: 'New Release' }).click();
    await page.locator('#release-title').fill(releaseTitle);
    await page.locator('#release-tag').fill(releaseTag);
    await page.locator('#release-notes').fill('Sidebar release smoke note');
    await page.getByRole('button', { name: 'Create Release' }).click();
    await expect(page.locator(`a:has-text("${releaseTitle}")`)).toBeVisible({ timeout: 20000 });

    await page.goto(`/git.html#/${route.npub}/${route.treeName}`);

    const releasesSidebar = page.getByTestId('repo-releases-sidebar');
    await expect(releasesSidebar).toBeVisible({ timeout: 20000 });
    await expect(releasesSidebar.getByTestId('repo-releases-link')).toHaveText('Releases');
    await expect(releasesSidebar.getByTestId('repo-latest-release-link')).toHaveText(releaseTitle);
    await expect(releasesSidebar).toContainText('Latest');
    await expect(releasesSidebar).toContainText(releaseTag);

    const repoTabNav = page.getByTestId('repo-tab-nav');
    await expect(repoTabNav.getByRole('link', { name: 'Releases' })).toHaveCount(0);

    await releasesSidebar.getByTestId('repo-releases-link').click();
    await page.waitForURL(/tab=releases/, { timeout: 20000 });
    await page.locator(`a:has-text("${releaseTitle}")`).click();

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete' }).click();

    await page.waitForURL(/tab=releases/, { timeout: 20000 });
  });
});
