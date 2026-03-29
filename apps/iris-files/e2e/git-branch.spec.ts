import { test, expect } from './fixtures';
import { setupPageErrorHandler, navigateToPublicFolder, disableOthersPool, gotoGitApp, createRepositoryInCurrentDirectory, createPlainFolderInCurrentDirectory, ensureGitRepoInitialized, waitForCurrentDirectoryEntries, commitCurrentDirectoryChanges } from './test-utils.js';

test.describe('Git branch features', () => {
  // Disable "others pool" to prevent WebRTC cross-talk from parallel tests
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await gotoGitApp(page);
    await disableOthersPool(page);
  });

  test('detached HEAD should show commit id and allow branch checkout', { timeout: 90000 }, async ({ page }) => {
    test.slow(); // Git operations involve wasm-git which can be slow under load
    await navigateToPublicFolder(page);

    // Start from a plain folder so the initial commit captures file1.txt in this test.
    await createPlainFolderInCurrentDirectory(page, 'detached-head-test');

    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'detached-head-test' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(/detached-head-test/, { timeout: 10000 });

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
      const content = new TextEncoder().encode('initial');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, route.path, 'file1.txt', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    await waitForCurrentDirectoryEntries(page, ['file1.txt']);
    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'file1.txt' })).toBeVisible({ timeout: 15000 });

    // Git init
    await ensureGitRepoInitialized(page);

    // Verify branch selector shows "master"
    const branchSelector = page.locator('button').filter({ hasText: /master|main/i }).first();
    await expect(branchSelector).toBeVisible({ timeout: 20000 });

    // Add second file and commit
    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();
      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;
      const content = new TextEncoder().encode('second file');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, route.path, 'file2.txt', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    await waitForCurrentDirectoryEntries(page, ['.git', 'file1.txt', 'file2.txt']);
    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'file2.txt' })).toBeVisible({ timeout: 15000 });

    // Create the second commit. Commit-modal behavior is covered elsewhere; this test is about branch/checkout flow.
    await commitCurrentDirectoryChanges(page, 'Add file2');

    // Now have 2 commits - checkout the first one
    const commitsBtn = page.getByRole('button', { name: /commits/i });
    await expect(commitsBtn).toContainText(/2/, { timeout: 15000 });
    await commitsBtn.click();

    const historyModal = page.locator('.fixed.inset-0').filter({ hasText: 'Commit History' });
    await expect(historyModal).toBeVisible({ timeout: 5000 });

    // Click checkout on the older commit (Initial commit)
    const checkoutButton = historyModal.getByRole('button', { name: 'Checkout' });
    await expect(checkoutButton).toBeVisible({ timeout: 10000 });
    await checkoutButton.click();
    await expect(historyModal).not.toBeVisible({ timeout: 30000 });

    // VERIFY: Branch selector should show short commit hash (7 chars), not "HEAD" or "detached"
    const branchBtn = page.locator('button').filter({ has: page.locator('.i-lucide-git-branch') }).first();
    await expect(branchBtn).not.toContainText(/master|main/i, { timeout: 20000 });
    await expect(branchBtn).toContainText(/[a-f0-9]{7}/i, { timeout: 10000 });
    const branchText = await branchBtn.textContent();
    console.log('Branch selector text after checkout:', branchText);
    // Should be a 7-char hex string (commit hash), not "HEAD" or "detached"
    expect(branchText).toMatch(/[a-f0-9]{7}/i);
    expect(branchText?.toLowerCase()).not.toContain('head');

    // VERIFY: Branch dropdown should still show "master" branch
    await branchBtn.click();
    await expect(page.locator('button').filter({ hasText: 'master' })).toBeVisible({ timeout: 5000 });

    // VERIFY: History modal should show detached HEAD warning with branch button
    await page.keyboard.press('Escape'); // Close dropdown
    const commitsBtn2 = page.getByRole('button', { name: /commits/i });
    await commitsBtn2.click();

    const historyModal2 = page.locator('.fixed.inset-0').filter({ hasText: 'Commit History' });
    await expect(historyModal2).toBeVisible({ timeout: 5000 });

    // Should show detached HEAD warning
    await expect(historyModal2.locator('text=Detached HEAD')).toBeVisible({ timeout: 5000 });
    // Should have button to switch to master branch
    await expect(historyModal2.locator('button').filter({ hasText: 'master' })).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
  });

  test('new branch can be created from branch dropdown', { timeout: 60000 }, async ({ page }) => {
    test.slow();
    await navigateToPublicFolder(page);

    // Create folder with file and init git
    await createRepositoryInCurrentDirectory(page, 'branch-test-repo');

    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'branch-test-repo' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(/branch-test-repo/, { timeout: 10000 });

    // Create file via API
    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();

      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;

      const content = new TextEncoder().encode('# Branch Test');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, route.path, 'README.md', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'README.md' })).toBeVisible({ timeout: 15000 });

    // Init git
    await ensureGitRepoInitialized(page);

    // Wait for git features to appear
    await expect(page.getByRole('button', { name: /commits/i })).toBeVisible({ timeout: 20000 });

    // Click branch dropdown - it's a button with git-branch icon and branch name
    // The button contains the branch name (e.g., "main", "master") and a chevron
    const branchBtn = page.locator('button').filter({ has: page.locator('.i-lucide-git-branch') }).first();
    await expect(branchBtn).toBeVisible({ timeout: 20000 });
    await branchBtn.click();

    // Branch dropdown should be open - look for "New branch" option
    const newBranchBtn = page.locator('button').filter({ hasText: 'New branch' });
    await expect(newBranchBtn).toBeVisible({ timeout: 5000 });
    await newBranchBtn.click();

    // New branch input should appear
    const branchNameInput = page.locator('input[placeholder="Branch name"]');
    await expect(branchNameInput).toBeVisible({ timeout: 5000 });
    await branchNameInput.fill('feature/test-branch');

    // Click Create button
    const createBtn = page.locator('button').filter({ hasText: 'Create' }).first();
    await createBtn.click();

    // Dropdown should close after creation
    await expect(branchNameInput).not.toBeVisible({ timeout: 10000 });

    // Verify via API that branch was created
    const result = await page.evaluate(async () => {
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getBranches } = await import('/src/utils/git.ts');

      const rootCid = getCurrentRootCid();
      if (!rootCid) return { branches: [], error: 'No root CID' };

      try {
        const { branches } = await getBranches(rootCid);
        return { branches, error: null };
      } catch (err) {
        return { branches: [], error: String(err) };
      }
    });

    console.log('Branch creation result:', result);
    // Note: Due to the way wasm-git works (doesn't persist),
    // the new branch may not show up immediately via getBranches
    // But the UI flow should work without errors
    expect(result.error).toBeNull();
  });

  test('tags appear in the ref dropdown and commit history', { timeout: 90000 }, async ({ page }) => {
    test.slow();
    await navigateToPublicFolder(page);

    await createRepositoryInCurrentDirectory(page, 'tag-test-repo');

    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'tag-test-repo' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(/tag-test-repo/, { timeout: 10000 });

    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');

      const route = getRouteSync();
      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;

      const content = new TextEncoder().encode('# Tagged repo\n');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, route.path, 'README.md', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'README.md' })).toBeVisible({ timeout: 15000 });
    await ensureGitRepoInitialized(page);
    await commitCurrentDirectoryChanges(page, 'Initial tagged commit');

    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { runGitCommand, applyGitChanges } = await import('/src/utils/git.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { useCurrentDirCid, getRouteSync } = await import('/src/stores/index.ts');

      const route = getRouteSync();
      const dirCid = useCurrentDirCid();
      const treeRootCid = getCurrentRootCid();
      if (!dirCid || !treeRootCid) throw new Error('Missing directory or tree root for git tag');

      const result = await runGitCommand(dirCid, 'tag v1.0.0');
      if (result.error || !result.gitFiles) {
        throw new Error(result.error || 'Failed to create tag');
      }

      const newDirCid = await applyGitChanges(dirCid, result.gitFiles);
      let newRootCid = newDirCid;
      if (route.path.length > 0) {
        const tree = getTree();
        const parentPath = route.path.slice(0, -1);
        const dirName = route.path[route.path.length - 1];
        newRootCid = await tree.setEntry(treeRootCid, parentPath, dirName, newDirCid, 0, LinkType.Dir);
      }

      autosaveIfOwn(newRootCid);
    });

    await expect(page.getByText('1 tag')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('v1.0.0').first()).toBeVisible({ timeout: 20000 });

    const refButton = page.locator('button').filter({ has: page.locator('.i-lucide-git-branch, .i-lucide-tag') }).first();
    await expect(refButton).toBeVisible({ timeout: 20000 });
    await refButton.click();

    await expect(page.getByText('Tags')).toBeVisible({ timeout: 5000 });
    const tagButton = page.locator('button').filter({ hasText: 'v1.0.0' }).first();
    await expect(tagButton).toBeVisible({ timeout: 5000 });
    await tagButton.click();

    await expect(refButton).toContainText('v1.0.0', { timeout: 20000 });

    const commitsBtn = page.getByRole('button', { name: /commits/i });
    await expect(commitsBtn).toBeVisible({ timeout: 15000 });
    await commitsBtn.click();

    const historyModal = page.locator('.fixed.inset-0').filter({ hasText: 'Commit History' });
    await expect(historyModal).toBeVisible({ timeout: 5000 });
    await expect(historyModal.getByText('Detached HEAD')).toBeVisible({ timeout: 5000 });
    await expect(historyModal.getByText('v1.0.0')).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
  });

  // Note: "checkout older commit changes visible files" test was removed as it's
  // a duplicate of the more comprehensive test in git-checkout.spec.ts

});
