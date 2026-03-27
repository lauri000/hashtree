import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readdir, stat } from 'node:fs/promises';
import { runPortableSmoke } from './portable-smoke-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const distDir = path.join(appDir, 'dist-video');
const screenshotPath = path.join(appDir, 'test-results', 'video-iris-portable-smoke.png');
const playlistScreenshotPath = path.join(appDir, 'test-results', 'video-iris-portable-playlist-smoke.png');
const playlistRootScreenshotPath = path.join(appDir, 'test-results', 'video-iris-portable-playlist-root-smoke.png');
const playlistOwnerNpub = 'npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk';
const playlistTreeName = 'videos/Music';
const playlistRootHash = '#/npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk/videos%2FMusic';
const playlistRouteHash = '#/npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk/videos%2FMusic/video_1767136152580';

async function main() {
  const entryHtml = await resolveEntryHtml();
  const assetNames = await readdir(path.join(distDir, 'assets'));
  const workerAssets = assetNames.filter((name) => /^hashtree\.worker-.*\.js$/.test(name));
  const workerAsset = workerAssets.length === 0
    ? null
    : (await Promise.all(
      workerAssets.map(async (name) => ({
        name,
        size: (await stat(path.join(distDir, 'assets', name))).size,
      })),
    )).sort((a, b) => b.size - a.size)[0]?.name ?? null;
  if (!workerAsset) {
    throw new Error('Portable video build is missing the hashtree worker asset');
  }

  await runPortableSmoke({
    distDir,
    title: 'Iris Video',
    appName: 'video',
    entryHtml,
    screenshotPath,
    validatePage: async (page) => {
      async function waitStep(name, pageFunction, arg, options) {
        try {
          return await page.waitForFunction(pageFunction, arg, options);
        } catch (error) {
          const state = await page.evaluate(() => {
            const video = document.querySelector('video');
            return {
              hash: window.location.hash,
              title: document.title,
              bodyPreview: document.body.innerText.slice(0, 500),
              sidebar: !!document.querySelector('[data-testid="playlist-sidebar"]'),
              video: video ? {
                currentSrc: video.currentSrc,
                readyState: video.readyState,
                networkState: video.networkState,
                error: video.error ? {
                  code: video.error.code,
                  message: video.error.message ?? null,
                } : null,
              } : null,
              debugLog: Array.isArray(window.__HTREE_DEBUG_LOG__)
                ? window.__HTREE_DEBUG_LOG__.slice(-40)
                : null,
            };
          }).catch(() => null);
          throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}\nstate=${JSON.stringify(state)}`);
        }
      }

      const hasVisibleThumbs = await page.waitForFunction(() => {
        const thumbs = Array.from(document.querySelectorAll('.aspect-video'));
        return thumbs.some((thumb) => {
          const rect = thumb.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0 && rect.height > 0;
        });
      }, undefined, { timeout: 10000 }).then(() => true).catch(() => false);

      if (!hasVisibleThumbs) {
        return;
      }

      await waitStep('home:visible-thumbs-loaded', () => {
        const thumbs = Array.from(document.querySelectorAll('.aspect-video'));
        const visible = thumbs.filter((thumb) => {
          const rect = thumb.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0 && rect.height > 0;
        }).slice(0, 6);

        if (visible.length === 0) return false;

        return visible.every((thumb) => {
          if (thumb.querySelector('[data-testid="generated-thumbnail-poster"]')) return true;
          if (thumb.querySelector('[data-testid="media-placeholder"]')) return true;
          const img = thumb.querySelector('img');
          return !!img && !!img.currentSrc && img.complete && img.naturalWidth > 0;
        });
      }, undefined, { timeout: 30000 });

      await waitStep('home:worker-adapter-ready', () => !!window.__getWorkerAdapter?.(), undefined, { timeout: 30000 });
      await waitStep('home:service-worker-controlled', () => !!navigator.serviceWorker?.controller, undefined, { timeout: 30000 });
      await waitStep('home:storage-stats-ready', async () => {
        const adapter = window.__getWorkerAdapter?.();
        if (!adapter) return false;
        try {
          const stats = await adapter.getStorageStats();
          return typeof stats?.items === 'number' && typeof stats?.bytes === 'number';
        } catch {
          return false;
        }
      }, undefined, { timeout: 30000 });

      const probe = await page.evaluate(async (workerAssetPath) => {
        return await new Promise((resolve) => {
          const result = { ready: false, messages: [], error: null };
          const worker = new Worker(workerAssetPath, { type: 'module' });
          const timeoutId = setTimeout(() => {
            resolve(result);
          }, 5000);

          worker.onmessage = (event) => {
            result.messages.push(event.data?.type ?? event.data);
            if (event.data?.type === 'ready') {
              result.ready = true;
              clearTimeout(timeoutId);
              worker.terminate();
              resolve(result);
            }
          };
          worker.onerror = (event) => {
            result.error = {
              message: event.message,
              filename: event.filename,
              lineno: event.lineno,
              colno: event.colno,
            };
            clearTimeout(timeoutId);
            worker.terminate();
            resolve(result);
          };

          worker.postMessage({
            type: 'init',
            id: 'portable-smoke-worker-probe',
            config: {
              storeName: 'portable-smoke-worker-probe',
              relays: [],
              blossomServers: [],
              pubkey: 'f'.repeat(64),
            },
          });
        });
      }, `/assets/${workerAsset}`);

      if (!probe.ready) {
        throw new Error(`Portable build failed worker bootstrap probe: ${JSON.stringify(probe)}`);
      }

      await page.evaluate(() => {
        window.__HTREE_DEBUG__ = true;
        window.__HTREE_DEBUG_LOG__ = [];
        localStorage.setItem('htree.debug', '1');
      });

      await waitStep('playlist:root-prewarm', async ({ npub, treeName }) => {
        const adapter = window.__getWorkerAdapter?.();
        if (!adapter?.getTreeRootInfo) return false;
        try {
          const info = await adapter.getTreeRootInfo(npub, treeName);
          return !!info?.hash;
        } catch {
          return false;
        }
      }, { npub: playlistOwnerNpub, treeName: playlistTreeName }, { timeout: 90000 });

      const appOrigin = new URL(page.url()).origin;
      await page.goto('about:blank', { waitUntil: 'load', timeout: 30000 });

      const playlistRootUrl = `${appOrigin}/${entryHtml}${playlistRootHash}`;
      await page.goto(playlistRootUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

      await waitStep('playlist:root-redirect-playable', () => {
        const bodyText = document.body.innerText;
        if (bodyText.includes('Video file not found') || bodyText.includes('Video failed to load')) {
          return false;
        }
        const hash = window.location.hash;
        const video = document.querySelector('video');
        const redirectedToChild = /\/videos%2FMusic\/video_/.test(hash);
        return redirectedToChild
          && !!video
          && !!video.currentSrc
          && video.currentSrc.includes('/htree/')
          && !video.error
          && (video.readyState >= 1 || video.networkState === 2);
      }, undefined, { timeout: 60000 });

      await page.screenshot({ path: playlistRootScreenshotPath, fullPage: true });

      const playlistUrl = `${appOrigin}/${entryHtml}${playlistRouteHash}`;
      await page.goto(playlistUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

      await waitStep('playlist:child-sidebar-visible', () => {
        return !!document.querySelector('[data-testid="playlist-sidebar"]');
      }, undefined, { timeout: 60000 });

      await waitStep('playlist:child-playable', () => {
        const bodyText = document.body.innerText;
        if (bodyText.includes('Video file not found') || bodyText.includes('Video failed to load')) {
          return false;
        }
        const video = document.querySelector('video');
        return !!video
          && !!video.currentSrc
          && video.currentSrc.includes('/htree/')
          && !video.error
          && (video.readyState >= 1 || video.networkState === 2);
      }, undefined, { timeout: 60000 });

      const playlistState = await page.evaluate(() => {
        const sidebar = document.querySelector('[data-testid="playlist-sidebar"]');
        const buttons = sidebar ? Array.from(sidebar.querySelectorAll('button')) : [];
        const itemButtons = buttons.filter((button) => {
          const text = button.textContent?.trim() ?? '';
          return !!button.querySelector('img, [data-testid="media-placeholder"]') && text.length > 0;
        });
        return {
          itemCount: itemButtons.length,
          currentHash: window.location.hash,
        };
      });

      if (playlistState.itemCount < 2) {
        throw new Error(`Portable build did not expose a usable playlist sidebar: ${JSON.stringify(playlistState)}`);
      }

      await page.screenshot({ path: playlistScreenshotPath, fullPage: true });
    },
  });
}

async function resolveEntryHtml() {
  const candidates = ['index.html', 'video.html'];
  for (const candidate of candidates) {
    try {
      await access(path.join(distDir, candidate));
      return candidate;
    } catch {}
  }
  throw new Error('Portable video build is missing an HTML entrypoint');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
