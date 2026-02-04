/**
 * Video viewing regression test
 *
 * Ensures that a viewer can load thumbnails and play a public video
 * from a production relay/blossom-backed tree.
 */
import { test, expect, type Page } from './fixtures';
import {
  setupPageErrorHandler,
  disableOthersPool,
  waitForAppReady,
  waitForRelayConnected,
  configureBlossomServers,
  presetLocalRelayInDB,
  safeReload,
  useLocalRelay,
  ensureLoggedIn,
} from './test-utils';
import * as path from 'path';
import { fileURLToPath } from 'url';

const BASE_URL = 'http://localhost:5173';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_VIDEO = path.join(__dirname, 'fixtures', 'Big_Buck_Bunny_360_10s_1MB.mp4');

async function prepareLocalVideoSession(page: Page, url: string = '/video.html#/') {
  setupPageErrorHandler(page);
  await page.goto(`${BASE_URL}${url}`);
  await disableOthersPool(page);
  await configureBlossomServers(page);

  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
    sessionStorage.clear();
  });

  await presetLocalRelayInDB(page);
  await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000, url: `${BASE_URL}${url}` });
  await waitForAppReady(page, 60000);
  await useLocalRelay(page);
  await waitForRelayConnected(page, 30000);
  await disableOthersPool(page);
  await configureBlossomServers(page);
  await ensureLoggedIn(page);
}

async function uploadVideoViaUI(page: Page, title: string): Promise<{ videoUrl: string; npub: string }> {
  const createBtn = page.locator('button:has-text("Create")');
  await expect(createBtn).toBeVisible({ timeout: 15000 });
  await createBtn.click();
  const uploadOption = page.locator('button:has-text("Upload Video")').first();
  await expect(uploadOption).toBeVisible({ timeout: 5000 });
  await uploadOption.click();
  await expect(page.getByRole('heading', { name: 'Upload Video' })).toBeVisible({ timeout: 10000 });

  const fileInput = page.locator('input[type="file"][accept="video/*"]');
  await fileInput.setInputFiles(TEST_VIDEO);

  const titleInput = page.locator('input[placeholder="Video title"]');
  await expect(titleInput).toBeVisible({ timeout: 5000 });
  await titleInput.fill(title);

  await page.locator('.fixed button:has-text("Upload")').click();
  await page.waitForURL(/\/video\.html#\/npub.*\/videos%2F/, { timeout: 60000 });

  const npub = await page.evaluate(async () => {
    const { useNostrStore } = await import('/src/nostr');
    return useNostrStore.getState().npub || '';
  });

  return { videoUrl: page.url(), npub };
}

async function createTestPlaylist(page: Page, playlistName: string) {
  return await page.evaluate(async (name: string) => {
    const { getTree } = await import('/src/store.ts');
    const { nostrStore } = await import('/src/nostr.ts');
    const { updateLocalRootCacheHex } = await import('/src/treeRootCache.ts');
    const hashtree = await import('/src/lib/nhash.ts');
    const { toHex, videoChunker, cid } = hashtree;

    const tree = getTree();
    const npub: string = await new Promise((resolve) => {
      let unsub: (() => void) | null = null;
      unsub = nostrStore.subscribe((state: any) => {
        if (state.npub) {
          queueMicrotask(() => unsub?.());
          resolve(state.npub);
        }
      });
    });

    const videos = [
      { id: 'testVideo001', title: 'Test Video 1' },
      { id: 'testVideo002', title: 'Test Video 2' },
    ];

    const rootEntries: Array<{ name: string; cid: any; size: number }> = [];

    for (const video of videos) {
      const videoEntries: Array<{ name: string; cid: any; size: number }> = [];

      const videoData = new Uint8Array([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70]);
      const streamWriter = tree.createStream({ chunker: videoChunker() });
      await streamWriter.append(videoData);
      const videoResult = await streamWriter.finalize();
      videoEntries.push({
        name: 'video.mp4',
        cid: cid(videoResult.hash, videoResult.key),
        size: videoResult.size,
      });

      const titleData = new TextEncoder().encode(video.title);
      const titleResult = await tree.putFile(titleData, {});
      videoEntries.push({ name: 'title.txt', cid: titleResult.cid, size: titleResult.size });

      const videoDirResult = await tree.putDirectory(videoEntries, {});
      rootEntries.push({
        name: video.id,
        cid: videoDirResult.cid,
        size: videoEntries.reduce((sum, e) => sum + e.size, 0),
      });
    }

    const rootDirResult = await tree.putDirectory(rootEntries, {});
    const treeName = `videos/${name}`;
    const rootKey = rootDirResult.cid.key ? toHex(rootDirResult.cid.key) : undefined;
    updateLocalRootCacheHex(npub, treeName, toHex(rootDirResult.cid.hash), rootKey, 'public');

    return {
      npub,
      treeName,
      videos,
    };
  }, playlistName);
}

test('viewer plays a public video (local)', async ({ page }) => {
  test.slow();

  await prepareLocalVideoSession(page);
  await uploadVideoViaUI(page, `Local Playback ${Date.now()}`);

  const videoEl = page.locator('video');
  await expect(videoEl).toBeVisible({ timeout: 60000 });
  await videoEl.click({ force: true });

  await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (!video) return;
    video.muted = true;
    void video.play().catch(() => {});
  });

  await page.waitForFunction(() => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    return !!(video && video.currentTime > 0.2 && video.readyState >= 3);
  }, undefined, { timeout: 60000 });

  await page.screenshot({ path: 'e2e/screenshots/video-view-playing.png', fullPage: true });
});

test('viewer loads playlist sidebar items (local)', async ({ page }) => {
  test.slow();

  await prepareLocalVideoSession(page);
  const playlist = await createTestPlaylist(page, `Local Playlist ${Date.now()}`);

  const videoUrl = `/video.html#/${playlist.npub}/${encodeURIComponent(playlist.treeName)}/${playlist.videos[0].id}`;
  await page.goto(videoUrl);
  await waitForAppReady(page, 60000);

  await page.waitForFunction(async () => {
    const { currentPlaylist } = await import('/src/stores/playlist');
    let playlistData: { items?: unknown[] } | null = null;
    currentPlaylist.subscribe((value) => {
      playlistData = value as typeof playlistData;
    })();
    return !!(playlistData && playlistData.items && playlistData.items.length > 1);
  }, undefined, { timeout: 60000 });

  const sidebar = page.locator('[data-testid="playlist-sidebar"]:visible');
  await expect(sidebar).toBeVisible({ timeout: 60000 });
  await expect.poll(() => sidebar.locator('button').count(), { timeout: 60000 }).toBeGreaterThan(1);
  await expect(sidebar.getByText('Test Video 1')).toBeVisible({ timeout: 60000 });
  await expect(sidebar.getByText('Test Video 2')).toBeVisible({ timeout: 60000 });

  await page.screenshot({ path: 'e2e/screenshots/video-playlist-sidebar.png', fullPage: true });
});
