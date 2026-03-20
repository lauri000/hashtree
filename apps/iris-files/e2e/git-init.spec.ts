import { test, expect } from './fixtures';
import { setupPageErrorHandler, navigateToPublicFolder, disableOthersPool, gotoGitApp } from './test-utils.js';

test.describe('Git init features', () => {
  // Disable "others pool" to prevent WebRTC cross-talk from parallel tests
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await gotoGitApp(page);
    await disableOthersPool(page);
  });

  test('new repository should be initialized as a git repo by default', { timeout: 60000 }, async ({ page }) => {
    test.slow();
    await navigateToPublicFolder(page);

    await page.getByRole('button', { name: 'New Repository' }).click();
    const folderInput = page.locator('input[placeholder="Repository name..."]');
    await folderInput.waitFor({ timeout: 5000 });
    await folderInput.fill('git-init-test');
    await page.click('button:has-text("Create")');
    await expect(page.locator('.fixed.inset-0.bg-black')).not.toBeVisible({ timeout: 10000 });

    // Wait for repository to appear and click into it
    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'git-init-test' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(/git-init-test/, { timeout: 10000 });

    const gitDir = page.locator('[data-testid="file-list"] a').filter({ hasText: '.git' }).first();
    await expect(gitDir).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Git Init' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: /commits/i })).toContainText(/1/, { timeout: 10000 });

    // Add a file and verify the repo reports uncommitted changes immediately.
    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();

      const tree = getTree();
      const rootCid = getCurrentRootCid();
      if (!rootCid) return;

      // Create a README.md file
      const content = new TextEncoder().encode('# Test Repo\n\nThis is a test.');
      const { cid: fileCid, size } = await tree.putFile(content);

      // Add to current directory
      const newRootCid = await tree.setEntry(rootCid, route.path, 'README.md', fileCid, size, LinkType.Blob);
      autosaveIfOwn(newRootCid);
    });

    // Wait for file to appear - check for the file in the list
    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'README.md' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button').filter({ hasText: /uncommitted/i })).toBeVisible({ timeout: 15000 });
  });

});
