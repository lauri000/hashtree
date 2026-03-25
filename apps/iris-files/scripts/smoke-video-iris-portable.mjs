import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { runPortableSmoke } from './portable-smoke-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const distDir = path.join(appDir, 'dist-video');
const screenshotPath = path.join(appDir, 'test-results', 'video-iris-portable-smoke.png');

async function main() {
  const assetNames = await readdir(path.join(distDir, 'assets'));
  const workerAsset = assetNames.find((name) => /^hashtree\.worker-.*\.js$/.test(name));
  if (!workerAsset) {
    throw new Error('Portable video build is missing the hashtree worker asset');
  }

  await runPortableSmoke({
    distDir,
    title: 'Iris Video',
    appName: 'video',
    screenshotPath,
    validatePage: async (page) => {
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

      await page.waitForFunction(() => {
        const thumbs = Array.from(document.querySelectorAll('.aspect-video'));
        const visible = thumbs.filter((thumb) => {
          const rect = thumb.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0 && rect.height > 0;
        }).slice(0, 6);

        if (visible.length === 0) return false;

        return visible.every((thumb) => {
          if (thumb.querySelector('.i-lucide-video')) return true;
          const img = thumb.querySelector('img');
          return !!img && !!img.currentSrc && img.complete && img.naturalWidth > 0;
        });
      }, undefined, { timeout: 30000 });

      await page.waitForFunction(() => !!window.__getWorkerAdapter?.(), undefined, { timeout: 30000 });
      await page.waitForFunction(() => !!navigator.serviceWorker?.controller, undefined, { timeout: 30000 });
      await page.waitForFunction(async () => {
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
    },
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
