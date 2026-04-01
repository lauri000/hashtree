import { test, expect } from './fixtures';
import { setupPageErrorHandler, navigateToPublicFolder, disableOthersPool, gotoGitApp, createRepositoryInCurrentDirectory, createPlainFolderInCurrentDirectory, ensureGitRepoInitialized, waitForCurrentDirectoryEntries } from './test-utils.js';
// Tests use isolated page contexts with disableOthersPool - safe for parallel execution

async function getCurrentCommitViewUrl(page: any): Promise<string> {
  const headerCommitLink = page.locator('thead a').first();
  await expect(headerCommitLink).toBeVisible({ timeout: 15000 });
  const href = await headerCommitLink.evaluate((anchor: HTMLAnchorElement) => anchor.href);
  expect(href).toContain('?commit=');
  return href;
}

test.describe('Git commit view', () => {
  test.use({ viewport: { width: 1200, height: 800 } });
  // Disable "others pool" to prevent WebRTC cross-talk from parallel tests
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await gotoGitApp(page);
    await disableOthersPool(page);
  });

  test('clicking commit message should navigate to commit view with details', { timeout: 90000 }, async ({ page }) => {
    test.slow();
    await navigateToPublicFolder(page);

    // Start from a plain folder so the initial commit captures the files created below.
    await createPlainFolderInCurrentDirectory(page, 'commit-view-test');

    // Navigate into the folder
    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'commit-view-test' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(/commit-view-test/, { timeout: 10000 });

    // Create initial files via the tree API
    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();

      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;

      // Create README.md
      const readmeContent = new TextEncoder().encode('# Commit View Test\n\nTesting the commit view functionality.');
      const { cid: readmeCid, size: readmeSize } = await tree.putFile(readmeContent);
      rootCid = await tree.setEntry(rootCid, route.path, 'README.md', readmeCid, readmeSize, LinkType.Blob);

      // Create index.js
      const indexContent = new TextEncoder().encode('console.log("Hello from commit view test!");');
      const { cid: indexCid, size: indexSize } = await tree.putFile(indexContent);
      rootCid = await tree.setEntry(rootCid, route.path, 'index.js', indexCid, indexSize, LinkType.Blob);

      autosaveIfOwn(rootCid);
    });

    await waitForCurrentDirectoryEntries(page, ['README.md', 'index.js']);
    // Wait for files to appear
    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'README.md' })).toBeVisible({ timeout: 15000 });

    await ensureGitRepoInitialized(page);

    // Verify commits button appears
    const commitsBtn = page.getByRole('button', { name: /commits/i });
    await expect(commitsBtn).toBeVisible({ timeout: 20000 });
    await expect(commitsBtn).toContainText(/1/, { timeout: 20000 });

    // Wait for file table commit messages to load
    // The header row should show commit info
    const headerCommitLink = page.locator('thead a').filter({ hasText: /Initial commit|Added files/ });
    await expect(headerCommitLink).toBeVisible({ timeout: 15000 });

    // Click on the commit message link in the header row
    await headerCommitLink.click();

    // Should navigate to commit view URL with ?commit= param
    await page.waitForURL(/\?commit=/, { timeout: 10000 });

    // Commit view should display commit details.
    const browseFilesBtn = page.locator('a').filter({ hasText: 'Browse files' });
    await expect(browseFilesBtn).toBeVisible({ timeout: 15000 });

    // Check for author info (Anonymous is default for wasm-git)
    await expect(page.locator('text=Anonymous').first()).toBeVisible({ timeout: 5000 });

    // Check for commit message
    await expect(page.locator('h1').filter({ hasText: /Initial commit|Added files/ })).toBeVisible({ timeout: 5000 });

    // Click Browse files to return to code view
    await browseFilesBtn.click();

    // Should navigate back to the repo (without ?commit= param)
    await expect(page).not.toHaveURL(/\?commit=/);

    // File table should be visible again
    await expect(page.locator('table tbody').first()).toBeVisible({ timeout: 10000 });
  });

  test('commit view shows commit details and browse files link', { timeout: 90000 }, async ({ page }) => {
    test.slow();
    await navigateToPublicFolder(page);

    // Create a folder for test
    await createRepositoryInCurrentDirectory(page, 'diff-view-test');

    // Navigate into the folder
    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'diff-view-test' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(/diff-view-test/, { timeout: 10000 });

    // Create initial file
    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();

      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;

      const content = new TextEncoder().encode('line 1\nline 2\nline 3\n');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, route.path, 'test.txt', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    // Wait for file
    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'test.txt' })).toBeVisible({ timeout: 15000 });

    // Init git
    await ensureGitRepoInitialized(page);

    // Wait for commits button
    await expect(page.getByRole('button', { name: /commits/i })).toBeVisible({ timeout: 20000 });

    // Navigate directly to commit view via URL
    await page.goto(await getCurrentCommitViewUrl(page));

    const browseFilesLink = page.locator('a').filter({ hasText: 'Browse files' });
    await expect(browseFilesLink).toBeVisible({ timeout: 15000 });

    // Check for commit message header
    await expect(page.locator('h1').filter({ hasText: /Initial commit|Added files/ })).toBeVisible({ timeout: 5000 });
  });

  test('commit view can open the full file at that commit', { timeout: 90000 }, async ({ page }) => {
    test.slow();
    await navigateToPublicFolder(page);

    await createRepositoryInCurrentDirectory(page, 'commit-file-view-test');

    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'commit-file-view-test' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(/commit-file-view-test/, { timeout: 10000 });

    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();

      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;

      const content = new TextEncoder().encode('# Commit File View Test\n\nThis file should open from a commit.');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, route.path, 'README.md', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'README.md' })).toBeVisible({ timeout: 15000 });
    await ensureGitRepoInitialized(page);

    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();

      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;

      const content = new TextEncoder().encode('# Commit File View Test\n\nThis file should open from a commit.\n\nUpdated line.');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, route.path, 'README.md', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    const uncommittedBtn = page.locator('button').filter({ hasText: /uncommitted/i });
    await expect(uncommittedBtn).toBeVisible({ timeout: 30000 });
    await uncommittedBtn.click();

    const commitModal = page.locator('.fixed.inset-0').filter({ hasText: 'Commit Changes' });
    await expect(commitModal).toBeVisible({ timeout: 5000 });
    await commitModal.locator('textarea[placeholder*="Describe"]').fill('Update README for commit file view');
    await commitModal.getByRole('button', { name: 'Commit' }).click();
    await expect(commitModal).not.toBeVisible({ timeout: 30000 });

    await page.goto(await getCurrentCommitViewUrl(page));

    const viewFileLink = page.locator('a').filter({ hasText: 'View file' }).first();
    await expect(viewFileLink).toBeVisible({ timeout: 15000 });
    await viewFileLink.click();

    await page.waitForURL(/view=file/, { timeout: 10000 });
    await expect(page.locator('[data-testid="commit-file-view"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="commit-file-view"]')).toContainText('Commit File View Test');
  });

  test('commit view handles nested files and back navigation', { timeout: 120000 }, async ({ page }) => {
    test.slow();
    await navigateToPublicFolder(page);

    await createRepositoryInCurrentDirectory(page, 'nested-commit-file-view-test');

    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'nested-commit-file-view-test' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(/nested-commit-file-view-test/, { timeout: 10000 });

    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();

      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;

      const { cid: srcCid } = await tree.putDirectory([]);
      rootCid = await tree.setEntry(rootCid, route.path, 'src', srcCid, 0, LinkType.Dir);

      const { cid: componentsCid } = await tree.putDirectory([]);
      rootCid = await tree.setEntry(rootCid, [...route.path, 'src'], 'components', componentsCid, 0, LinkType.Dir);

      const { cid: videoCid } = await tree.putDirectory([]);
      rootCid = await tree.setEntry(rootCid, [...route.path, 'src', 'components'], 'Video', videoCid, 0, LinkType.Dir);

      const content = new TextEncoder().encode('<script lang="ts">export let profile = "video";</script>\n');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, [...route.path, 'src', 'components', 'Video'], 'VideoProfileView.svelte', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    await ensureGitRepoInitialized(page);

    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();

      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;

      const content = new TextEncoder().encode('<script lang="ts">export let profile = "video-updated";</script>\n');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, [...route.path, 'src', 'components', 'Video'], 'VideoProfileView.svelte', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    const uncommittedBtn = page.locator('button').filter({ hasText: /uncommitted/i });
    await expect(uncommittedBtn).toBeVisible({ timeout: 30000 });
    await uncommittedBtn.click();

    const commitModal = page.locator('.fixed.inset-0').filter({ hasText: 'Commit Changes' });
    await expect(commitModal).toBeVisible({ timeout: 5000 });
    await commitModal.locator('textarea[placeholder*="Describe"]').fill('Update nested video profile view');
    await commitModal.getByRole('button', { name: 'Commit' }).click();
    await expect(commitModal).not.toBeVisible({ timeout: 30000 });

    await page.goto(await getCurrentCommitViewUrl(page));

    await expect(page.getByText('src/components/Video/VideoProfileView.svelte', { exact: true })).toBeVisible({ timeout: 15000 });

    const viewFileLink = page.locator('a').filter({ hasText: 'View file' }).first();
    await expect(viewFileLink).toBeVisible({ timeout: 15000 });
    await viewFileLink.click();

    await page.waitForURL(/view=file/, { timeout: 10000 });
    await expect(page.locator('[data-testid="commit-file-view"]')).toContainText('video-updated', { timeout: 20000 });
    await expect(page).toHaveURL(/g=/);

    const backToCommit = page.locator('a').filter({ hasText: 'Back to commit' });
    await expect(backToCommit).toBeVisible({ timeout: 10000 });
    await backToCommit.click();

    await page.waitForURL(/\?commit=/, { timeout: 10000 });
    await expect(page.locator('h1').filter({ hasText: 'Update nested video profile view' })).toBeVisible({ timeout: 15000 });
  });

  test('tab navigation shows on commit view', { timeout: 90000 }, async ({ page }) => {
    test.slow();
    await navigateToPublicFolder(page);

    // Create a folder
    await createRepositoryInCurrentDirectory(page, 'tab-nav-test');

    // Navigate into folder
    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'tab-nav-test' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(/tab-nav-test/, { timeout: 10000 });

    // Create file and init git
    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();

      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;

      const content = new TextEncoder().encode('test');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, route.path, 'test.txt', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'test.txt' })).toBeVisible({ timeout: 15000 });

    await ensureGitRepoInitialized(page);

    // Navigate to commit view
    await page.goto(await getCurrentCommitViewUrl(page));

    // Tab navigation should be visible with Code, Pull Requests, Issues tabs
    const tabNav = page.locator('a').filter({ hasText: 'Code' });
    await expect(tabNav).toBeVisible({ timeout: 10000 });

    const pullsTab = page.locator('a').filter({ hasText: 'Pull Requests' });
    await expect(pullsTab).toBeVisible({ timeout: 5000 });

    const issuesTab = page.locator('a').filter({ hasText: 'Issues' });
    await expect(issuesTab).toBeVisible({ timeout: 5000 });

    // Code tab should be active (highlighted)
    await expect(tabNav).toHaveClass(/b-b-accent/);
  });
});
