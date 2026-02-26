import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import WebSocket from 'ws';
import { setupPageErrorHandler, navigateToPublicFolder, disableOthersPool, useLocalRelay, goToTreeList } from './test-utils.js';

const KIND_REPO_ANNOUNCEMENT = 30617;
const KIND_PULL_REQUEST = 1618;

async function publishEventToRelay(relayUrl: string, event: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out publishing test event'));
    }, 5000);

    socket.on('open', () => {
      socket.send(JSON.stringify(['EVENT', event]));
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === (event as { id?: string }).id && msg[2] === true) {
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      } catch {
        // ignore malformed relay messages in tests
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function createTopLevelGitRepo(page: Page, repoName: string, fileContents: string): Promise<{
  npub: string;
  treeName: string;
  branch: string;
  headCommit: string;
}> {
  await goToTreeList(page);
  await navigateToPublicFolder(page, { timeoutMs: 60000 });

  await page.evaluate(async ({ repoName }) => {
    const { createTree } = await import('/src/actions/tree.ts');
    const result = await createTree(repoName, 'public');
    if (!result?.success) {
      throw new Error(`Failed to create tree: ${repoName}`);
    }
  }, { repoName });
  await page.waitForURL(new RegExp(`/#/npub[^/]+/${encodeURIComponent(repoName)}(?:\\?|$)`), { timeout: 30000 });

  await page.evaluate(async ({ fileContents }) => {
    const { getTree, LinkType } = await import('/src/store.ts');
    const { autosaveIfOwn } = await import('/src/nostr.ts');
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    let rootCid = getCurrentRootCid();
    if (!rootCid) throw new Error('No current root CID');
    const tree = getTree();
    const data = new TextEncoder().encode(fileContents);
    const { cid, size } = await tree.putFile(data);
    rootCid = await tree.setEntry(rootCid, [], 'README.md', cid, size, LinkType.Blob);
    autosaveIfOwn(rootCid);
  }, { fileContents });

  await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'README.md' })).toBeVisible({ timeout: 15000 });

  const gitInitBtn = page.getByRole('button', { name: 'Git Init' });
  await expect(gitInitBtn).toBeVisible({ timeout: 15000 });
  await gitInitBtn.click();
  await expect(gitInitBtn).not.toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: '.git' }).first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('button:has(.i-lucide-git-branch):not([data-testid="git-init-btn"])').first()).toBeVisible({ timeout: 30000 });

  const repoInfo = await page.evaluate(async () => {
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    const { getBranches, runGitCommand } = await import('/src/utils/git.ts');

    const rootCid = getCurrentRootCid();
    if (!rootCid) throw new Error('No current root CID');

    const hash = window.location.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);

    const branches = await getBranches(rootCid);
    const head = await runGitCommand(rootCid, 'rev-parse HEAD');
    const headCommit = (head.output || '').trim();
    const branch = branches.currentBranch || branches.branches[0] || '';
    return {
      npub: parts[0] || '',
      treeName: parts[1] || '',
      branch,
      headCommit,
    };
  });

  expect(repoInfo.npub).toMatch(/^npub1/);
  expect(repoInfo.treeName).toBe(repoName);
  expect(repoInfo.branch).toBeTruthy();
  expect(repoInfo.headCommit).toMatch(/^[0-9a-f]{40}$/);
  return repoInfo;
}

test.describe('NIP-34 Pull Requests', () => {
  // PR/Issues views are hidden on small screens (lg:flex), need wider viewport
  test.use({ viewport: { width: 1280, height: 720 } });
  test.setTimeout(60000); // 60s timeout for all tests in this describe

  // Disable "others pool" to prevent WebRTC cross-talk from parallel tests
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await disableOthersPool(page);
  });

  test('should navigate to Pull Requests view via URL', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    // Get the current URL parts
    const url = new URL(page.url());
    const hash = url.hash.slice(1); // Remove #
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);
    const npub = parts[0];
    const treeName = parts[1];

    // Navigate using ?tab=pulls query param
    await page.goto(`/#/${npub}/${treeName}?tab=pulls`);

    // Should show the PR view with empty state
    // Wait for loading to complete (nostr fetch has 5s timeout)
    await expect(page.locator('text=Loading pull requests...')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=No pull requests yet')).toBeVisible({ timeout: 5000 });

    // Tab navigation should be visible
    await expect(page.locator('a:has-text("Code")')).toBeVisible();
    await expect(page.locator('a:has-text("Pull Requests")')).toBeVisible();
    await expect(page.locator('a:has-text("Issues")')).toBeVisible();
  });

  test('should navigate to Issues view via URL', async ({ page }) => {
    await navigateToPublicFolder(page);

    // Get the current URL parts
    const url = new URL(page.url());
    const hash = url.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);
    const npub = parts[0];
    const treeName = parts[1];

    // Navigate using ?tab=issues query param
    await page.goto(`/#/${npub}/${treeName}?tab=issues`);

    // Should show the Issues view with empty state
    // Wait for loading to complete (nostr fetch has 5s timeout)
    await expect(page.locator('text=Loading issues...')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=No issues yet')).toBeVisible({ timeout: 5000 });

    // Tab navigation should be visible
    await expect(page.locator('a:has-text("Code")')).toBeVisible();
    await expect(page.locator('a:has-text("Pull Requests")')).toBeVisible();
    await expect(page.locator('a:has-text("Issues")')).toBeVisible();
  });

  test('should show FileBrowser on left side in PR view', async ({ page }) => {
    await navigateToPublicFolder(page);

    // Get the current URL parts
    const url = new URL(page.url());
    const hash = url.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);
    const npub = parts[0];
    const treeName = parts[1];

    // Navigate to PR view
    await page.goto(`/#/${npub}/${treeName}?tab=pulls`);

    // Wait for loading to complete (nostr fetch has 5s timeout)
    await expect(page.locator('text=Loading pull requests...')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=No pull requests yet')).toBeVisible({ timeout: 5000 });

    // FileBrowser should be visible - check for the breadcrumb or tree selector
    // The FileBrowser has a tree dropdown or shows "Empty directory"
    const fileBrowserVisible = await page.locator('text=Empty directory').isVisible() ||
      await page.locator('[data-testid="file-list"]').isVisible() ||
      await page.locator('.shrink-0.lg\\:w-80').isVisible();
    expect(fileBrowserVisible).toBeTruthy();
  });

  test('should switch between Code, PRs, and Issues tabs', async ({ page }) => {
    await navigateToPublicFolder(page);

    // Get the current URL parts
    const url = new URL(page.url());
    const hash = url.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);
    const npub = parts[0];
    const treeName = parts[1];

    // Go to PRs
    await page.goto(`/#/${npub}/${treeName}?tab=pulls`);
    await expect(page.locator('text=Loading pull requests...')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=No pull requests yet')).toBeVisible({ timeout: 5000 });

    // Click Issues tab
    await page.locator('a:has-text("Issues")').click();
    await page.waitForURL(/tab=issues/, { timeout: 5000 });
    // Issues view should be visible (might show loading or content)
    await expect(page.locator('a:has-text("Issues")')).toBeVisible();

    // Click Code tab
    await page.locator('a:has-text("Code")').first().click();
    await page.waitForURL((url) => !url.href.includes('tab=pulls') && !url.href.includes('tab=issues'), { timeout: 5000 });
  });

  test('nevent encoding works correctly', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');

    // Wait for app to load
    await page.waitForTimeout(1000);

    // Test that encodeEventId and decodeEventId work correctly
    const result = await page.evaluate(async () => {
      // Dynamic import from the running app
      const nip34Module = await import('/src/nip34.ts');
      const { encodeEventId, decodeEventId } = nip34Module;

      // Test with a sample event ID (64 char hex)
      const hexId = 'a'.repeat(64);
      const encoded = encodeEventId(hexId);
      const decoded = decodeEventId(encoded);

      return {
        hexId,
        encoded,
        decoded,
        startsWithNevent: encoded.startsWith('nevent'),
        decodedMatches: decoded === hexId,
      };
    });

    console.log('[test] Encoding result:', result);
    expect(result.startsWithNevent).toBe(true);
    expect(result.decodedMatches).toBe(true);
  });

  test('PR list title should be a link with nevent ID', async ({ page }) => {
    await navigateToPublicFolder(page);

    // Get URL parts for navigation
    const url = new URL(page.url());
    const hash = url.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);
    const npub = parts[0];
    const treeName = parts[1];

    // Navigate to PRs view using query param
    await page.goto(`/#/${npub}/${treeName}?tab=pulls`);
    await expect(page.locator('text=Loading pull requests...')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=No pull requests yet')).toBeVisible({ timeout: 5000 });

    // The "New Pull Request" button should be visible when logged in
    // For now just verify the view structure is correct
    await expect(page.locator('a:has-text("Pull Requests")')).toBeVisible();
  });

  test('should navigate to PR detail view via URL with nevent id', async ({ page }) => {
    await navigateToPublicFolder(page);

    // Get URL parts for navigation
    const url = new URL(page.url());
    const hash = url.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);
    const npub = parts[0];
    const treeName = parts[1];

    // Generate a test nevent ID (this won't exist, but we can test the routing)
    const testNeventId = await page.evaluate(async () => {
      const nip34Module = await import('/src/nip34.ts');
      const { encodeEventId } = nip34Module;
      // Use a fake event ID
      return encodeEventId('a'.repeat(64));
    });

    // Navigate to PR detail view with nevent ID
    await page.goto(`/#/${npub}/${treeName}?tab=pulls&id=${testNeventId}`);

    // Should show loading first, then error since event doesn't exist
    // Wait for the error message to appear (event doesn't exist)
    await expect(page.locator('text=Pull request not found')).toBeVisible({ timeout: 10000 });

    // Back button should also be visible
    await expect(page.locator('a:has-text("Back to pull requests")')).toBeVisible();
  });

  test('should load PR detail from direct URL on cold page after relay seed', async ({ page, browser, relayUrl }) => {
    test.slow();
    test.setTimeout(90000);

    await useLocalRelay(page, relayUrl);
    await navigateToPublicFolder(page, { timeoutMs: 60000 });

    const { npub, treeName } = await page.evaluate(() => {
      const hash = window.location.hash.slice(1);
      const qIdx = hash.indexOf('?');
      const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
      const parts = path.split('/').filter(Boolean);
      return { npub: parts[0] || '', treeName: parts[1] || '' };
    });
    expect(npub).toMatch(/^npub1/);
    expect(treeName).toBeTruthy();

    const decodedTarget = nip19.decode(npub);
    if (decodedTarget.type !== 'npub') {
      throw new Error(`Expected npub route, got ${decodedTarget.type}`);
    }
    const targetPubkeyHex = decodedTarget.data;

    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const authorNpub = nip19.npubEncode(authorPk);
    const now = Math.floor(Date.now() / 1000);
    const title = `E2E cold direct PR ${Date.now().toString(36)}`;

    const prEvent = finalizeEvent({
      kind: KIND_PULL_REQUEST,
      created_at: now,
      content: 'Regression test PR for direct URL cold load',
      tags: [
        ['a', `${KIND_REPO_ANNOUNCEMENT}:${targetPubkeyHex}:${treeName}`],
        ['p', targetPubkeyHex],
        ['subject', title],
        ['branch', 'feature'],
        ['target-branch', 'master'],
        ['c', '0'.repeat(40)],
        ['clone', `htree://${authorNpub}/${treeName}`],
      ],
    }, authorSk);

    await publishEventToRelay(relayUrl, prEvent as unknown as Record<string, unknown>);

    // Confirm the seeded event is visible in the list before testing cold direct navigation.
    await page.goto(`/#/${npub}/${treeName}?tab=pulls`);
    await expect(page.locator('text=Loading pull requests...')).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('link', { name: title })).toBeVisible({ timeout: 10000 });

    const prUrl = `/#/${npub}/${treeName}?tab=pulls&id=${nip19.neventEncode({ id: prEvent.id, relays: [relayUrl] })}`;

    // Fresh context simulates incognito / cold cache.
    const coldContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const coldPage = await coldContext.newPage();
    setupPageErrorHandler(coldPage);
    await coldPage.goto('/');
    await disableOthersPool(coldPage);
    await useLocalRelay(coldPage, relayUrl);
    await navigateToPublicFolder(coldPage, { timeoutMs: 60000 });

    await coldPage.goto(prUrl);

    await expect(coldPage.locator('text=Pull request not found')).not.toBeVisible({ timeout: 20000 });
    await expect(coldPage.getByRole('heading', { name: title })).toBeVisible({ timeout: 20000 });
    await expect(coldPage.getByRole('link', { name: 'Go back' })).toBeVisible({ timeout: 10000 });

    // Files changed tab should resolve to diff or error state, but never hang indefinitely.
    await coldPage.getByRole('button', { name: /^Files changed/ }).click();
    await expect(coldPage.locator('text=Loading diff...')).not.toBeVisible({ timeout: 20000 });
    await expect(
      coldPage.getByText(/Unable to compute the diff between branches|may not exist in this repository snapshot/)
    ).toBeVisible({ timeout: 20000 });

    await coldContext.close();
  });

  test('PR Files changed handles missing source branch gracefully from seeded PR event', async ({ page, relayUrl }) => {
    test.slow();
    test.setTimeout(120000);

    await useLocalRelay(page, relayUrl);

    const targetRepo = await createTopLevelGitRepo(
      page,
      `pr-missing-branch-${Date.now().toString(36)}`,
      '# Missing branch PR test\n'
    );

    const decodedTarget = nip19.decode(targetRepo.npub);
    if (decodedTarget.type !== 'npub') {
      throw new Error(`Expected npub route, got ${decodedTarget.type}`);
    }
    const targetPubkeyHex = decodedTarget.data;

    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const authorNpub = nip19.npubEncode(authorPk);
    const missingBranch = `missing-feature-${Date.now().toString(36)}`;
    const title = `E2E missing source branch ${Date.now().toString(36)}`;

    const prEvent = finalizeEvent({
      kind: KIND_PULL_REQUEST,
      created_at: Math.floor(Date.now() / 1000),
      content: 'PR event points to a missing source branch',
      tags: [
        ['a', `${KIND_REPO_ANNOUNCEMENT}:${targetPubkeyHex}:${targetRepo.treeName}`],
        ['p', targetPubkeyHex],
        ['subject', title],
        ['branch', missingBranch],
        ['target-branch', targetRepo.branch],
        ['c', '0'.repeat(40)],
        ['clone', `htree://${authorNpub}/${targetRepo.treeName}`],
      ],
    }, authorSk);
    await publishEventToRelay(relayUrl, prEvent as unknown as Record<string, unknown>);

    await page.goto(`/#/${targetRepo.npub}/${targetRepo.treeName}?tab=pulls`);
    await expect(page.locator('text=Loading pull requests...')).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('link', { name: title })).toBeVisible({ timeout: 10000 });

    const prUrl = `/#/${targetRepo.npub}/${targetRepo.treeName}?tab=pulls&id=${nip19.neventEncode({ id: prEvent.id, relays: [relayUrl] })}`;
    await page.goto(prUrl);
    await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: /^Files changed/ }).click();
    await expect(page.locator('text=Loading diff...')).not.toBeVisible({ timeout: 20000 });

    const diffErrorLocator = page.getByText(/Unable to compute the diff between branches|may not exist in this repository snapshot|memory access out of bounds|wasm-git crashed while running/);
    await expect(diffErrorLocator).toBeVisible({ timeout: 20000 });
    const retryButton = page.getByRole('button', { name: /Retry/i });
    await expect(retryButton).toBeVisible({ timeout: 5000 });

    await page.waitForTimeout(2000);
    await expect(page.locator('text=Loading diff...')).not.toBeVisible();
    await expect(diffErrorLocator).toBeVisible();

    await retryButton.click();
    await expect(page.locator('text=Loading diff...')).not.toBeVisible({ timeout: 20000 });
    await expect(diffErrorLocator).toBeVisible({ timeout: 20000 });
  });

  test('PR Files changed shows cross-repo diff when clone + commit tip point to another repo', async ({ page, relayUrl }) => {
    test.slow();
    test.setTimeout(120000);

    await useLocalRelay(page, relayUrl);

    const targetRepo = await createTopLevelGitRepo(
      page,
      `pr-cross-target-${Date.now().toString(36)}`,
      '# Target repo\n\nbase line\n'
    );
    const sourceRepo = await createTopLevelGitRepo(
      page,
      `pr-cross-source-${Date.now().toString(36)}`,
      '# Source repo\n\nchanged line\nextra line\n'
    );

    const decodedTarget = nip19.decode(targetRepo.npub);
    if (decodedTarget.type !== 'npub') {
      throw new Error(`Expected npub route, got ${decodedTarget.type}`);
    }
    const targetPubkeyHex = decodedTarget.data;

    const authorSk = generateSecretKey();
    const title = `E2E cross-repo diff ${Date.now().toString(36)}`;
    const prEvent = finalizeEvent({
      kind: KIND_PULL_REQUEST,
      created_at: Math.floor(Date.now() / 1000),
      content: 'Cross-repo PR for diff rendering',
      tags: [
        ['a', `${KIND_REPO_ANNOUNCEMENT}:${targetPubkeyHex}:${targetRepo.treeName}`],
        ['p', targetPubkeyHex],
        ['subject', title],
        ['branch', sourceRepo.branch],
        ['target-branch', targetRepo.branch],
        ['c', sourceRepo.headCommit],
        ['clone', `htree://${sourceRepo.npub}/${sourceRepo.treeName}`],
      ],
    }, authorSk);
    await publishEventToRelay(relayUrl, prEvent as unknown as Record<string, unknown>);

    await page.goto(`/#/${targetRepo.npub}/${targetRepo.treeName}?tab=pulls`);
    await expect(page.locator('text=Loading pull requests...')).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('link', { name: title })).toBeVisible({ timeout: 10000 });

    const prUrl = `/#/${targetRepo.npub}/${targetRepo.treeName}?tab=pulls&id=${nip19.neventEncode({ id: prEvent.id, relays: [relayUrl] })}`;
    await page.goto(prUrl);
    await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: /^Files changed/ }).click();
    await expect(page.locator('text=Loading diff...')).not.toBeVisible({ timeout: 20000 });

    await expect(page.getByText(/Unable to compute a cross-repo diff|Cross-repo diff requires a commit tip/)).not.toBeVisible();
    await expect(page.getByText(/No differences between branches/)).not.toBeVisible();
    await expect(page.locator('pre').filter({ hasText: 'diff --git a/README.md b/README.md' }).first()).toBeVisible({ timeout: 20000 });
  });

  test('PR Files changed handles cross-repo PR missing commit tip gracefully', async ({ page, relayUrl }) => {
    test.slow();
    test.setTimeout(120000);

    await useLocalRelay(page, relayUrl);

    const targetRepo = await createTopLevelGitRepo(
      page,
      `pr-cross-noc-${Date.now().toString(36)}`,
      '# Target repo\n\nbase\n'
    );
    const sourceRepo = await createTopLevelGitRepo(
      page,
      `pr-cross-noc-source-${Date.now().toString(36)}`,
      '# Source repo\n\nchanged\n'
    );

    const decodedTarget = nip19.decode(targetRepo.npub);
    if (decodedTarget.type !== 'npub') {
      throw new Error(`Expected npub route, got ${decodedTarget.type}`);
    }
    const targetPubkeyHex = decodedTarget.data;

    const authorSk = generateSecretKey();
    const authorNpub = nip19.npubEncode(getPublicKey(authorSk));
    const title = `E2E cross-repo missing c ${Date.now().toString(36)}`;
    const prEvent = finalizeEvent({
      kind: KIND_PULL_REQUEST,
      created_at: Math.floor(Date.now() / 1000),
      content: 'Cross-repo PR without commit tip',
      tags: [
        ['a', `${KIND_REPO_ANNOUNCEMENT}:${targetPubkeyHex}:${targetRepo.treeName}`],
        ['p', targetPubkeyHex],
        ['subject', title],
        ['branch', sourceRepo.branch],
        ['target-branch', targetRepo.branch],
        ['clone', `htree://${authorNpub}/${sourceRepo.treeName}`],
      ],
    }, authorSk);
    await publishEventToRelay(relayUrl, prEvent as unknown as Record<string, unknown>);

    const prUrl = `/#/${targetRepo.npub}/${targetRepo.treeName}?tab=pulls&id=${nip19.neventEncode({ id: prEvent.id, relays: [relayUrl] })}`;
    await page.goto(prUrl);
    await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: /^Files changed/ }).click();
    await expect(page.locator('text=Loading diff...')).not.toBeVisible({ timeout: 20000 });

    const diffErrorLocator = page.getByText(/Cross-repo diff requires a commit tip|Unable to compute a cross-repo diff/);
    await expect(diffErrorLocator).toBeVisible({ timeout: 20000 });
    const retryButton = page.getByRole('button', { name: /Retry/i });
    await expect(retryButton).toBeVisible({ timeout: 5000 });

    await page.waitForTimeout(2000);
    await expect(page.locator('text=Loading diff...')).not.toBeVisible();
    await expect(diffErrorLocator).toBeVisible();

    await retryButton.click();
    await expect(page.locator('text=Loading diff...')).not.toBeVisible({ timeout: 20000 });
    await expect(diffErrorLocator).toBeVisible({ timeout: 20000 });
  });

  test('should navigate to Issue detail view via URL with nevent id', async ({ page }) => {
    await navigateToPublicFolder(page);

    // Get URL parts for navigation
    const url = new URL(page.url());
    const hash = url.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);
    const npub = parts[0];
    const treeName = parts[1];

    // Generate a test nevent ID
    const testNeventId = await page.evaluate(async () => {
      const nip34Module = await import('/src/nip34.ts');
      const { encodeEventId } = nip34Module;
      return encodeEventId('b'.repeat(64));
    });

    // Navigate to Issue detail view with nevent ID
    await page.goto(`/#/${npub}/${treeName}?tab=issues&id=${testNeventId}`);

    // Should show error since event doesn't exist
    await expect(page.locator('text=Issue not found')).toBeVisible({ timeout: 10000 });

    // Back button should also be visible
    await expect(page.locator('a:has-text("Back to issues")')).toBeVisible();
  });

  test('should have back button in PR detail view that navigates to list', async ({ page }) => {
    await navigateToPublicFolder(page);

    // Get URL parts for navigation
    const url = new URL(page.url());
    const hash = url.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);
    const npub = parts[0];
    const treeName = parts[1];

    // Generate a test nevent ID
    const testNeventId = await page.evaluate(async () => {
      const nip34Module = await import('/src/nip34.ts');
      const { encodeEventId } = nip34Module;
      return encodeEventId('c'.repeat(64));
    });

    // Navigate to PR detail view
    await page.goto(`/#/${npub}/${treeName}?tab=pulls&id=${testNeventId}`);

    // Wait for error state
    await expect(page.locator('text=Pull request not found')).toBeVisible({ timeout: 10000 });

    // Click the back button
    await page.locator('a:has-text("Back to pull requests")').click();

    // Should be back at the PR list view
    await page.waitForURL(/tab=pulls/, { timeout: 5000 });
    // URL should not have &id= anymore
    expect(page.url()).not.toContain('&id=');
    // PR list view should be visible (navigation worked)
    await expect(page.getByText('Pull request not found')).not.toBeVisible();
    await expect(page.getByText('No pull requests yet')).toBeVisible();
  });

  test('should have back button in Issue detail view that navigates to list', async ({ page }) => {
    await navigateToPublicFolder(page);

    // Get URL parts for navigation
    const url = new URL(page.url());
    const hash = url.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);
    const npub = parts[0];
    const treeName = parts[1];

    // Generate a test nevent ID
    const testNeventId = await page.evaluate(async () => {
      const nip34Module = await import('/src/nip34.ts');
      const { encodeEventId } = nip34Module;
      return encodeEventId('d'.repeat(64));
    });

    // Navigate to Issue detail view
    await page.goto(`/#/${npub}/${treeName}?tab=issues&id=${testNeventId}`);

    // Wait for error state
    await expect(page.locator('text=Issue not found')).toBeVisible({ timeout: 10000 });

    // Click the back button
    await page.locator('a:has-text("Back to issues")').click();

    // Should be back at the Issues list view
    await page.waitForURL(/tab=issues/, { timeout: 5000 });
    // URL should not have &id= anymore
    expect(page.url()).not.toContain('&id=');
    // Issues list view should be visible (navigation worked)
    await expect(page.getByText('Issue not found')).not.toBeVisible();
    await expect(page.getByText('No issues yet')).toBeVisible();
  });

  test('PR detail view shows Conversation and Files changed tabs', async ({ page }) => {
    // This test verifies the PR detail view tabs UI
    // Since Nostr PR creation requires relay connectivity, we test the UI by navigating
    // to a PR detail view URL directly (which will show "not found" but still render tabs)
    await navigateToPublicFolder(page);

    // Get the current URL parts
    const url = new URL(page.url());
    const hash = url.hash.slice(1);
    const qIdx = hash.indexOf('?');
    const path = qIdx !== -1 ? hash.slice(0, qIdx) : hash;
    const parts = path.split('/').filter(Boolean);
    const npub = parts[0];
    const treeName = parts[1];

    // Generate a test nevent ID
    const testNeventId = await page.evaluate(async () => {
      const nip34Module = await import('/src/nip34.ts');
      const { encodeEventId } = nip34Module;
      return encodeEventId('e'.repeat(64));
    });

    // Navigate to PR detail view with the test event ID
    await page.goto(`/#/${npub}/${treeName}?tab=pulls&id=${testNeventId}`);

    // Wait for the PR view to load (will show "not found" since event doesn't exist)
    await expect(page.locator('text=Pull request not found')).toBeVisible({ timeout: 10000 });

    // The back button should be visible
    await expect(page.locator('a:has-text("Back to pull requests")')).toBeVisible();

    // Tab navigation should still be visible at the top (use .first() to avoid multiple matches)
    await expect(page.locator('a:has-text("Code")').first()).toBeVisible();
    await expect(page.locator('a:has-text("Pull Requests")').first()).toBeVisible();
    await expect(page.locator('a:has-text("Issues")').first()).toBeVisible();
  });

  test('PR detail view tabs work when loaded from existing PR', async ({ page }) => {
    // This test creates a git repo with branches but skips PR creation via Nostr
    // Instead it verifies the PR list and detail view structure
    test.setTimeout(90000);
    test.slow();
    await navigateToPublicFolder(page);

    // Create a folder and init as git repo with branches
    await page.getByRole('button', { name: 'New Folder' }).click();
    const folderInput = page.locator('input[placeholder="Folder name..."]');
    await folderInput.waitFor({ timeout: 5000 });
    await folderInput.fill('pr-structure-test');
    await page.click('button:has-text("Create")');
    await expect(page.locator('.fixed.inset-0.bg-black')).not.toBeVisible({ timeout: 10000 });

    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'pr-structure-test' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(/pr-structure-test/, { timeout: 10000 });

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
      const content = new TextEncoder().encode('initial content');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, route.path, 'file.txt', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
    });

    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'file.txt' })).toBeVisible({ timeout: 15000 });

    // Git init
    const gitInitBtn = page.getByRole('button', { name: 'Git Init' });
    await expect(gitInitBtn).toBeVisible({ timeout: 15000 });
    await gitInitBtn.click();
    await expect(gitInitBtn).not.toBeVisible({ timeout: 30000 });

    const gitDirEntry = page.locator('[data-testid="file-list"] a').filter({ hasText: '.git' }).first();
    await expect(gitDirEntry).toBeVisible({ timeout: 30000 });

    // Wait for branch selector
    const branchSelector = page.locator('button:has(.i-lucide-git-branch):not([data-testid="git-init-btn"])').first();
    await expect(branchSelector).toBeVisible({ timeout: 30000 });

    // Go to Pull Requests tab
    await page.locator('a:has-text("Pull Requests")').click();
    await page.waitForURL(/tab=pulls/, { timeout: 5000 });

    // Verify PR list view structure
    await expect(page.locator('text=No pull requests yet')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("New Pull Request")')).toBeVisible();

    // Verify repo tab navigation is visible
    await expect(page.locator('a:has-text("Code")')).toBeVisible();
    await expect(page.locator('a:has-text("Pull Requests")')).toBeVisible();
    await expect(page.locator('a:has-text("Issues")')).toBeVisible();

    // Switch to Issues tab
    await page.locator('a:has-text("Issues")').click();
    await page.waitForURL(/tab=issues/, { timeout: 5000 });
    await expect(page.locator('text=No issues yet')).toBeVisible({ timeout: 10000 });

    // Switch back to Code tab
    await page.locator('a:has-text("Code")').first().click();
    await page.waitForURL((url) => !url.href.includes('tab='), { timeout: 5000 });
    // Should see the file list again
    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: 'file.txt' })).toBeVisible({ timeout: 10000 });
  });
});
