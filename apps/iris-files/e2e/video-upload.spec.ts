import { test, expect, type Page } from './fixtures';
import fs from 'fs';
import path from 'path';
import {
  configureBlossomServers,
  disableOthersPool,
  ensureLoggedIn,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils';

const TEST_VIDEO_NAME = 'Big_Buck_Bunny_360_10s.webm';
const TEST_VIDEO_PATH = path.resolve(process.cwd(), `e2e/fixtures/${TEST_VIDEO_NAME}`);

type WorkerAdapterLike = {
  sendHello?: () => Promise<void> | void;
  readFile?: (cid: unknown) => Promise<Uint8Array | null>;
  readFileRange?: (cid: unknown, start: number, end: number) => Promise<Uint8Array | null>;
};

type VideoUploadTestWindow = Window & {
  __getWorkerAdapter?: () => WorkerAdapterLike | null | undefined;
  __workerAdapter?: WorkerAdapterLike | null;
};

async function ensureTestVideo(): Promise<string> {
  if (!fs.existsSync(TEST_VIDEO_PATH)) {
    throw new Error(`Missing test video fixture: ${TEST_VIDEO_PATH}`);
  }
  const stat = fs.statSync(TEST_VIDEO_PATH);
  if (stat.size <= 0) {
    throw new Error(`Invalid empty test video fixture: ${TEST_VIDEO_PATH}`);
  }
  return TEST_VIDEO_PATH;
}

// Login as test user and wait for login to complete
async function loginAsTestUser(page: Page) {
  await page.evaluate(() => {
    // Use a fixed test nsec for reproducibility
    const testNsec = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
    localStorage.setItem('nostr-login', JSON.stringify({ nsec: testNsec }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 30000 });
  // Wait for login to complete - Create button appears when logged in
  await page.locator('button:has-text("Create"), a:has-text("Create")').first().waitFor({ state: 'visible', timeout: 15000 });
}

async function waitForVideoData(page: Page, timeoutMs = 180000) {
  const started = Date.now();
  let lastStatus: Record<string, unknown> | null = null;

  while (Date.now() - started < timeoutMs) {
    lastStatus = await page.evaluate(async () => {
      const status: Record<string, unknown> = {};
      try {
        const hash = window.location.hash;
        const match = hash.match(/#\/(npub1[a-z0-9]+)\/([^/?]+)/);
        if (!match) return { ok: false, reason: 'route-parse-failed', hash };

        const npub = match[1];
        const treeName = decodeURIComponent(match[2]);
        status.npub = npub;
        status.treeName = treeName;

        const { getTreeRootSync } = await import('/src/stores');
        const { getTree } = await import('/src/store');
        const root = getTreeRootSync(npub, treeName);
        if (!root) return { ok: false, reason: 'missing-root', ...status };

        status.hasRootKey = !!root.key;
        const adapter = (window as VideoUploadTestWindow).__getWorkerAdapter?.()
          ?? (window as VideoUploadTestWindow).__workerAdapter;
        if (!adapter?.readFile && !adapter?.readFileRange) {
          return { ok: false, reason: 'adapter-not-ready', ...status };
        }

        await adapter.sendHello?.();
        const tree = getTree();
        const candidates = ['video.webm', 'video.mp4', 'video.mov', 'video.mkv'];

        for (const name of candidates) {
          let entry: { cid?: unknown } | null = null;
          try {
            entry = await Promise.race([
              tree.resolvePath(root, name),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
            ]) as { cid?: unknown } | null;
          } catch (err) {
            return { ok: false, reason: 'resolve-path-error', fileName: name, error: String(err), ...status };
          }

          if (!entry?.cid) continue;
          status.fileName = name;

          try {
            const read = () => {
              if (typeof adapter.readFileRange === 'function') {
                return adapter.readFileRange(entry!.cid, 0, 1024);
              }
              return adapter.readFile(entry!.cid);
            };
            const data = await Promise.race([
              read(),
              new Promise<Uint8Array | null>((resolve) => setTimeout(() => resolve(null), 10000)),
            ]);
            const len = data?.length ?? 0;
            if (len > 0) {
              return { ok: true, fileName: name, bytes: len, ...status };
            }
            return { ok: false, reason: 'read-empty', fileName: name, bytes: len, ...status };
          } catch (err) {
            return { ok: false, reason: 'read-file-error', fileName: name, error: String(err), ...status };
          }
        }

        return { ok: false, reason: 'video-entry-not-found', ...status };
      } catch (err) {
        return { ok: false, reason: 'unexpected-error', error: String(err), ...status };
      }
    });

    if (lastStatus?.ok === true) return;
    const elapsed = Date.now() - started;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 2500) break;
    await page.waitForTimeout(Math.min(2000, remaining - 500));
  }

  throw new Error(`Video data unavailable after ${timeoutMs}ms: ${JSON.stringify(lastStatus)}`);
}

async function waitForVideoPlayback(page: Page, timeoutMs = 120000) {
  const videoElement = page.locator('video');
  await expect(videoElement).toBeVisible({ timeout: timeoutMs });

  await page.waitForFunction(() => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    return !!(video && video.readyState >= 2 && !video.error && (video.currentSrc || video.src));
  }, undefined, { timeout: timeoutMs });

  await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (!video) return;
    video.muted = true;
    if (video.readyState === 0) {
      video.load();
    }
    void video.play().catch(() => {});
  });

  await page.waitForFunction(() => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (!video) return false;
    if (video.paused) {
      void video.play().catch(() => {});
    }
    return video.currentTime > 0.2 && video.readyState >= 2 && !video.error;
  }, undefined, { timeout: timeoutMs });
}

async function uploadVideoWithVisibility(
  page: Page,
  visibility: 'public' | 'link-visible' | 'private',
  title: string,
): Promise<string> {
  await page.goto('/video.html#/create');

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(TEST_VIDEO_PATH);

  const titleInput = page.getByPlaceholder(/title/i);
  await titleInput.waitFor({ state: 'visible', timeout: 10000 });
  await titleInput.fill(title);

  const visibilityButton = page.getByRole('button', { name: new RegExp(visibility, 'i') }).first();
  await visibilityButton.click();

  const uploadButton = page.getByRole('button', { name: 'Upload Video' });
  await uploadButton.click();

  await expect(page).toHaveURL(/videos(%2F|\/)/i, { timeout: 90000 });
  return page.url();
}

async function getCurrentPubkey(page: Page): Promise<string> {
  const pubkey = await page.evaluate(() => (window as { __nostrStore?: { getState?: () => { pubkey?: string | null } } }).__nostrStore?.getState?.().pubkey ?? null);
  if (!pubkey) {
    throw new Error('Could not resolve current pubkey');
  }
  return pubkey;
}

async function prepareNonOwnerViewer(page: Page, ownerPubkey: string): Promise<void> {
  await page.goto('/video.html#/');
  await waitForAppReady(page, 60000);
  await disableOthersPool(page);
  await configureBlossomServers(page);
  await ensureLoggedIn(page, 30000);
  await waitForRelayConnected(page, 30000);

  const initialPubkey = await getCurrentPubkey(page);
  if (initialPubkey !== ownerPubkey) return;

  await page.evaluate(async () => {
    const { generateNewKey } = await import('/src/nostr');
    await generateNewKey();
  });
  await page.waitForFunction((owner) => {
    const pubkey = (window as { __nostrStore?: { getState?: () => { pubkey?: string | null } } }).__nostrStore?.getState?.().pubkey;
    return !!pubkey && pubkey !== owner;
  }, ownerPubkey, { timeout: 15000 });
  await waitForRelayConnected(page, 30000);
}

test.describe('Video Upload with Visibility', () => {
  test.beforeAll(async () => {
    await ensureTestVideo();
  });

  test('should upload link-visible video and show correct icon after refresh', async ({ page, browser }) => {
    test.slow(); // This test involves video upload which can be slow

    // Login
    await page.goto('/video.html');
    await loginAsTestUser(page);

    // Navigate to create page
    await page.goto('/video.html#/create');

    // Upload video file (input is hidden, use setInputFiles directly)
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_VIDEO_PATH);

    // Wait for title input to appear (shows after file is selected and processed)
    const titleInput = page.getByPlaceholder(/title/i);
    await titleInput.waitFor({ state: 'visible', timeout: 10000 });

    // Set title
    const testTitle = `Test Link-Visible ${Date.now()}`;
    await titleInput.fill(testTitle);

    // Set visibility to link-visible (click the Link button)
    const linkVisibleButton = page.getByRole('button', { name: /link/i }).first();
    await linkVisibleButton.click();

    // Click upload button (use the one that says "Upload Video")
    const uploadButton = page.getByRole('button', { name: 'Upload Video' });
    await uploadButton.click();

    // Wait for upload to complete - URL changes to video page
    await expect(page).toHaveURL(/videos(%2F|\/)/i, { timeout: 90000 });

    // Get the video URL
    const videoUrl = page.url();
    console.log('Video URL:', videoUrl);

    // Verify k param is in URL (link-visible uses encryption key in URL)
    expect(videoUrl).toContain('k=');

    // Wait for page to stabilize after navigation
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 30000 });

    // Wait for video page to load - h1 title appears
    const titleElement = page.locator('h1');
    await expect(titleElement).toBeVisible({ timeout: 15000 });
    await expect(titleElement).toContainText('Test Link-Visible');

    // CRITICAL: Verify video actually loads with content
    const videoElement = page.locator('video');
    await expect(videoElement).toBeVisible({ timeout: 30000 });

    // Verify video has loaded content (not empty element)
    const mediaSetup = await page.evaluate(async () => {
      const { ensureMediaStreamingReady, isMediaStreamingSetup } = await import('/src/lib/mediaStreamingSetup.ts');
      const result = await ensureMediaStreamingReady(5, 1000);
      return { result, isSetup: isMediaStreamingSetup() };
    });
    console.log('Media streaming setup:', mediaSetup);
    let attemptedReload = false;
    await expect.poll(async () => {
      const videoState = await page.evaluate(() => {
        const v = document.querySelector('video') as HTMLVideoElement | null;
        if (!v) {
          return { hasSrc: false, reason: 'no-video', readyState: 0 };
        }
        if (v.readyState === 0 && v.src) {
          v.load();
        }
        const src = v.currentSrc || v.src;
        return { hasSrc: !!src, reason: src ? 'has-src' : 'no-src', readyState: v.readyState };
      });
      if (!videoState.hasSrc && videoState.reason === 'no-video') {
        const failedVisible = await page.getByText('Video failed to load').isVisible().catch(() => false);
        if (failedVisible && !attemptedReload) {
          attemptedReload = true;
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 30000 });
          await expect(page.locator('h1')).toBeVisible({ timeout: 30000 });
        }
      }
      console.log('Video state:', videoState);
      return videoState.hasSrc;
    }, { timeout: 60000, intervals: [1000, 2000, 3000, 5000] }).toBe(true);

    await waitForVideoData(page, 120000);

    // Screenshot to verify video loaded
    await page.screenshot({ path: 'test-results/link-visible-upload.png' });

    // Check for visibility icon (link icon for link-visible)
    const visibilityIcon = page.getByTitle('Link-visible (link only)');
    await expect(visibilityIcon).toBeVisible({ timeout: 5000 });

    // CRITICAL: Open in fresh browser context to verify nostr persistence (no local cache)
    // Fresh context verifies tree root is published to nostr and can be resolved
    // Note: Video DATA may not load in fresh context without blossom servers
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(videoUrl);

    // Verify the page loads - title appears (not "Video not found" error)
    // This proves the tree root was resolved from nostr
    const freshTitleElement = freshPage.locator('h1');
    await expect(freshTitleElement).toBeVisible({ timeout: 30000 });
    await expect(freshTitleElement).toContainText('Test Link-Visible');

    // Verify visibility icon in fresh browser (proves metadata loaded from nostr)
    const freshVisibilityIcon = freshPage.getByTitle('Link-visible (link only)');
    await expect(freshVisibilityIcon).toBeVisible({ timeout: 5000 });

    // Screenshot from fresh browser
    await freshPage.screenshot({ path: 'test-results/link-visible-fresh-browser.png' });

    await freshContext.close();
  });

  test('should upload private video and show correct icon after refresh', async ({ page }) => {
    // Login
    await page.goto('/video.html');
    await loginAsTestUser(page);

    // Navigate to create page
    await page.goto('/video.html#/create');

    // Upload video file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_VIDEO_PATH);

    // Wait for title input
    const titleInput = page.getByPlaceholder(/title/i);
    await titleInput.waitFor({ state: 'visible', timeout: 10000 });

    // Set title
    const testTitle = `Test Private ${Date.now()}`;
    await titleInput.fill(testTitle);

    // Set visibility to private (click the Private button)
    const privateButton = page.getByRole('button', { name: /private/i });
    await privateButton.click();

    // Click upload button
    const uploadButton = page.getByRole('button', { name: 'Upload Video' });
    await uploadButton.click();

    // Wait for upload to complete
    await expect(page).toHaveURL(/videos(%2F|\/)/i, { timeout: 90000 });

    // Get the video URL
    const videoUrl = page.url();
    console.log('Video URL:', videoUrl);

    // Wait for video page to load
    const titleElement = page.locator('h1');
    await expect(titleElement).toBeVisible({ timeout: 15000 });
    await expect(titleElement).toContainText('Test Private');

    // CRITICAL: Verify video actually loads
    const videoElement = page.locator('video');
    await expect(videoElement).toBeVisible({ timeout: 60000 });

    // Check for visibility icon (lock icon for private)
    const visibilityIcon = page.locator('[title*="Private"]');
    await expect(visibilityIcon).toBeVisible({ timeout: 5000 });

    // Refresh page to test persistence from nostr
    await page.reload();
    const debugAfterReload = await page.evaluate(async () => {
      const hash = window.location.hash;
      const match = hash.match(/#\/(npub1[a-z0-9]+)\/([^/?]+)/);
      const npub = match?.[1] ?? null;
      const treeName = match?.[2] ? decodeURIComponent(match[2]) : null;
      const stores = await import('/src/stores');
      const root = npub && treeName ? stores.getTreeRootSync(npub, treeName) : null;
      const adapter = (window as VideoUploadTestWindow).__getWorkerAdapter?.()
        ?? (window as VideoUploadTestWindow).__workerAdapter
        ?? null;
      let resolveVideo = null;
      if (root) {
        try {
          const { getTree } = await import('/src/store');
          const tree = getTree();
          const entry = await tree.resolvePath(root, 'video.webm').catch(() => null)
            ?? await tree.resolvePath(root, 'video.mp4').catch(() => null);
          resolveVideo = entry ? { hasEntry: true, hasCidKey: !!entry.cid?.key } : { hasEntry: false };
        } catch (err) {
          resolveVideo = { error: String(err) };
        }
      }
      return {
        npub,
        treeName,
        hasRoot: !!root,
        hasRootKey: !!root?.key,
        adapterReady: !!adapter,
        hasReadFileRange: !!adapter?.readFileRange,
        hasReadFile: !!adapter?.readFile,
        resolveVideo,
      };
    });
    console.log('Debug after reload:', debugAfterReload);
    await waitForVideoData(page, 180000);
    await waitForVideoPlayback(page, 120000);

    // CRITICAL: Verify video loads after refresh
    await expect(videoElement).toBeVisible({ timeout: 60000 });
    await expect(visibilityIcon).toBeVisible({ timeout: 5000 });
  });

  test('should auto-add k= param when owner navigates to link-visible without it', async ({ page }) => {
    test.slow(); // This test involves video upload which can be slow

    // Login
    await page.goto('/video.html');
    await loginAsTestUser(page);

    // Navigate to create page
    await page.goto('/video.html#/create');

    // Upload video file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_VIDEO_PATH);

    // Wait for title input
    const titleInput = page.getByPlaceholder(/title/i);
    await titleInput.waitFor({ state: 'visible', timeout: 10000 });

    // Set title
    const testTitle = `Test Owner Recovery ${Date.now()}`;
    await titleInput.fill(testTitle);

    // Set visibility to link-visible
    const linkVisibleButton = page.getByRole('button', { name: /link/i }).first();
    await linkVisibleButton.click();

    // Click upload button
    const uploadButton = page.getByRole('button', { name: 'Upload Video' });
    await uploadButton.click();

    // Wait for upload to complete - URL changes to video page with k= param
    await expect(page).toHaveURL(/videos(%2F|\/)/i, { timeout: 90000 });

    // Get the full video URL with k= param
    const fullUrl = page.url();
    console.log('Full URL:', fullUrl);
    expect(fullUrl).toContain('k=');

    // Extract the base URL without k= param
    const urlWithoutK = fullUrl.replace(/[?&]k=[a-f0-9]+/i, '');
    console.log('URL without k:', urlWithoutK);

    // Listen to console for debug messages
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    // Navigate to the URL WITHOUT the k= param
    await page.goto(urlWithoutK);

    // Print debug logs
    const treeRootLogs = consoleLogs.filter(l => l.includes('treeRoot'));
    console.log('treeRoot logs:', treeRootLogs.length ? treeRootLogs.join('\n') : 'NONE');

    // Check for resolver logs
    const resolverLogs = consoleLogs.filter(l => l.includes('Resolver'));
    console.log('Resolver logs:', resolverLogs.length ? resolverLogs.join('\n') : 'NONE');

    // Wait for page to load and k= to be auto-added
    // The URL should update to include k= via history.replaceState
    await expect(async () => {
      const currentUrl = page.url();
      console.log('Current URL after navigation:', currentUrl);
      expect(currentUrl).toContain('k=');
    }).toPass({ timeout: 15000 });

    // Wait for page to stabilize
    await page.waitForLoadState('domcontentloaded');

    // Verify the video title loads correctly
    const titleElement = page.locator('h1');
    await expect(titleElement).toBeVisible({ timeout: 15000 });
    await expect(titleElement).toContainText('Test Owner Recovery');

    // Verify the video element loads
    const videoElement = page.locator('video');
    await expect(videoElement).toBeVisible({ timeout: 15000 });
    await waitForVideoData(page, 120000);
    await waitForVideoPlayback(page, 120000);
  });

  test('shows link-required state instead of player failure for non-owners without the link key', async ({ page, browser }) => {
    await page.goto('/video.html');
    await loginAsTestUser(page);

    const ownerPubkey = await getCurrentPubkey(page);
    const title = `Protected Link Video ${Date.now()}`;
    const videoUrl = await uploadVideoWithVisibility(page, 'link-visible', title);
    const [, protectedHash] = videoUrl.split('?');
    expect(protectedHash).toContain('k=');

    const protectedUrl = videoUrl.replace(/[?&]k=[a-f0-9]+/i, '');
    const context = await browser.newContext();
    const page2 = await context.newPage();

    try {
      await prepareNonOwnerViewer(page2, ownerPubkey);
      await page2.goto(protectedUrl);
      await waitForAppReady(page2, 60000);
      await waitForRelayConnected(page2, 30000);

      const protectedNotice = page2.getByTestId('video-protected');
      await expect(protectedNotice).toBeVisible({ timeout: 30000 });
      await expect(protectedNotice.getByText('Link Required')).toBeVisible({ timeout: 30000 });
      await expect(protectedNotice.getByText('This video requires a special link to access. Ask the owner for the link with the access key.')).toBeVisible({ timeout: 30000 });
      await expect(page2.getByText('Video failed to load')).not.toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('shows private-video state instead of player failure for non-owners', async ({ page, browser }) => {
    await page.goto('/video.html');
    await loginAsTestUser(page);

    const ownerPubkey = await getCurrentPubkey(page);
    const title = `Protected Private Video ${Date.now()}`;
    const videoUrl = await uploadVideoWithVisibility(page, 'private', title);

    const context = await browser.newContext();
    const page2 = await context.newPage();

    try {
      await prepareNonOwnerViewer(page2, ownerPubkey);
      await page2.goto(videoUrl);
      await waitForAppReady(page2, 60000);
      await waitForRelayConnected(page2, 30000);

      const protectedNotice = page2.getByTestId('video-protected');
      await expect(protectedNotice).toBeVisible({ timeout: 30000 });
      await expect(protectedNotice.getByText('Private Video')).toBeVisible({ timeout: 30000 });
      await expect(protectedNotice.getByText('This video is private and can only be accessed by its owner.')).toBeVisible({ timeout: 30000 });
      await expect(page2.getByText('Video failed to load')).not.toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('should upload public video and NOT show visibility icon', async ({ page }) => {
    // Login
    await page.goto('/video.html');
    await loginAsTestUser(page);

    // Navigate to create page
    await page.goto('/video.html#/create');

    // Upload video file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(TEST_VIDEO_PATH);

    // Wait for title input
    const titleInput = page.getByPlaceholder(/title/i);
    await titleInput.waitFor({ state: 'visible', timeout: 10000 });

    // Set title
    const testTitle = `Test Public ${Date.now()}`;
    await titleInput.fill(testTitle);

    // Keep visibility as public (default - click Public button to ensure)
    const publicButton = page.getByRole('button', { name: /public/i });
    await publicButton.click();

    // Click upload button
    const uploadButton = page.getByRole('button', { name: 'Upload Video' });
    await uploadButton.click();

    // Wait for upload to complete
    await expect(page).toHaveURL(/videos(%2F|\/)/i, { timeout: 90000 });

    // Get the video URL
    const videoUrl = page.url();
    console.log('Video URL:', videoUrl);

    // Verify NO k param in URL (public doesn't need encryption key)
    expect(videoUrl).not.toContain('k=');

    // Wait for video page to load
    const titleElement = page.locator('h1');
    await expect(titleElement).toBeVisible({ timeout: 15000 });
    await expect(titleElement).toContainText('Test Public');

    // CRITICAL: Verify video actually loads
    const videoElement = page.locator('video');
    await expect(videoElement).toBeVisible({ timeout: 60000 });

    // Verify NO visibility icon for public videos
    const linkVisibleIcon = page.locator('[title*="Link-visible"]');
    const privateIcon = page.locator('[title*="Private"]');
    await expect(linkVisibleIcon).not.toBeVisible();
    await expect(privateIcon).not.toBeVisible();

    // Refresh page to test persistence from nostr
    await page.reload();
    await waitForVideoData(page, 180000);

    // CRITICAL: Verify video loads after refresh
    await expect(videoElement).toBeVisible({ timeout: 60000 });
  });
});
