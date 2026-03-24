import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPortableSmoke } from './portable-smoke-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const distDir = path.join(appDir, 'dist-video');
const screenshotPath = path.join(appDir, 'test-results', 'video-iris-portable-smoke.png');

async function main() {
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
    },
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
