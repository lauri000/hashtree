import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const ORIGIN = args[0] ?? 'https://video.iris.to/';
const OUT_DIR = path.resolve(import.meta.dirname, '..', 'test-results');
const JSON_PATH = path.join(OUT_DIR, 'feed-thumbnail-timing.json');
const SCREENSHOT_PATH = path.join(OUT_DIR, 'feed-thumbnail-timing-warm.png');
const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 100;
const STABLE_FOR_MS = 500;
const MIN_VISIBLE_OBSERVATION_MS = 3000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getVisibleThumbnailStats(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href^="#/npub"]'));
    const deduped = new Map();

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href');
      if (!href || deduped.has(href)) continue;

      const media = anchor.querySelector('.video-thumb, .playlist-thumb, .aspect-video');
      if (!media) continue;

      const rect = media.getBoundingClientRect();
      const visible = rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0 && rect.height > 0;
      if (!visible) continue;

      const img = media.querySelector('img');
      const placeholder = !!media.querySelector('[data-testid="media-placeholder"]');
      const opacityZero = !!img && getComputedStyle(img).opacity === '0';
      const loaded = !!img && img.complete && img.naturalWidth > 0 && !opacityZero;
      const broken = !!img && img.complete && img.naturalWidth === 0 && !opacityZero;
      const pending = (!!img && !loaded && !broken) || (placeholder && !!img);

      deduped.set(href, {
        href,
        loaded,
        placeholder,
        pending,
        broken,
      });
    }

    const cards = Array.from(deduped.values());
    return {
      total: cards.length,
      loaded: cards.filter((card) => card.loaded).length,
      placeholder: cards.filter((card) => card.placeholder).length,
      pending: cards.filter((card) => card.pending).length,
      broken: cards.filter((card) => card.broken).length,
      cards,
    };
  });
}

async function getVisibleThumbnailUrls(page, limit = 5) {
  return page.evaluate((maxUrls) => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href^="#/npub"] img'))
      .map((img) => img.getAttribute('src'))
      .filter((src) => !!src && src.startsWith('/htree/'))
      .filter((src) => {
        if (!src || seen.has(src)) return false;
        seen.add(src);
        return true;
      })
      .slice(0, maxUrls);
  }, limit);
}

async function probeOfflineThumbnailFetches(page, context) {
  const urls = await getVisibleThumbnailUrls(page);
  if (urls.length === 0) {
    return {
      totalTested: 0,
      allOk: false,
      results: [],
    };
  }

  await context.setOffline(true);
  try {
    const results = await page.evaluate(async (srcs) => {
      const offlineResults = [];
      for (const src of srcs) {
        try {
          const response = await fetch(src, { cache: 'no-store' });
          const bytes = await response.arrayBuffer();
          offlineResults.push({
            src,
            ok: response.ok,
            status: response.status,
            bytes: bytes.byteLength,
          });
        } catch (error) {
          offlineResults.push({
            src,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return offlineResults;
    }, urls);

    return {
      totalTested: results.length,
      allOk: results.length > 0 && results.every((result) => result.ok),
      results,
    };
  } finally {
    await context.setOffline(false);
  }
}

async function waitForVisibleThumbnailSettlement(page) {
  const startedAt = Date.now();
  let firstVisibleAt = 0;
  let stableSince = 0;
  let lastSignature = '';
  let lastStats = null;

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const stats = await getVisibleThumbnailStats(page);
    lastStats = stats;

    if (stats.total > 0) {
      if (!firstVisibleAt) {
        firstVisibleAt = Date.now();
      }
      const signature = JSON.stringify({
        total: stats.total,
        loaded: stats.loaded,
        placeholder: stats.placeholder,
        pending: stats.pending,
        broken: stats.broken,
      });

      if (stats.pending === 0) {
        if (signature !== lastSignature) {
          lastSignature = signature;
          stableSince = Date.now();
        } else if (
          Date.now() - stableSince >= STABLE_FOR_MS
          && (!firstVisibleAt || Date.now() - firstVisibleAt >= MIN_VISIBLE_OBSERVATION_MS)
        ) {
          return {
            elapsedMs: Date.now() - startedAt,
            firstVisibleMs: firstVisibleAt ? firstVisibleAt - startedAt : null,
            settleAfterFirstVisibleMs: firstVisibleAt ? Date.now() - firstVisibleAt : null,
            ...stats,
          };
        }
      } else {
        lastSignature = signature;
        stableSince = 0;
      }
    }

    await delay(POLL_INTERVAL_MS);
  }

  return {
    elapsedMs: Date.now() - startedAt,
    firstVisibleMs: firstVisibleAt ? firstVisibleAt - startedAt : null,
    settleAfterFirstVisibleMs: firstVisibleAt ? Date.now() - firstVisibleAt : null,
    ...(lastStats ?? { total: 0, loaded: 0, placeholder: 0, pending: 0, broken: 0, cards: [] }),
    timedOut: true,
  };
}

async function measurePass(page, label, navigate) {
  const startedAt = Date.now();
  await navigate();
  const settled = await waitForVisibleThumbnailSettlement(page);
  return {
    label,
    navigationAndSettleMs: Date.now() - startedAt,
    settleAfterDomContentLoadedMs: settled.elapsedMs,
    firstVisibleMs: settled.firstVisibleMs,
    settleAfterFirstVisibleMs: settled.settleAfterFirstVisibleMs,
    total: settled.total,
    loaded: settled.loaded,
    placeholder: settled.placeholder,
    pending: settled.pending,
    broken: settled.broken,
    timedOut: !!settled.timedOut,
    cards: settled.cards,
  };
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
const page = await context.newPage();

try {
  const cold = await measurePass(page, 'cold', () =>
    page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 })
  );
  const warm = await measurePass(page, 'warm-reload', () =>
    page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  );
  const offlineCacheProbe = await probeOfflineThumbnailFetches(page, context);

  await mkdir(OUT_DIR, { recursive: true });
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

  const result = {
    origin: ORIGIN,
    measuredAt: new Date().toISOString(),
    cold,
    warm,
    offlineCacheProbe,
    improvementMs: cold.navigationAndSettleMs - warm.navigationAndSettleMs,
  };

  await writeFile(JSON_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result, null, 2));
  console.log(`Saved ${JSON_PATH}`);
  console.log(`Saved ${SCREENSHOT_PATH}`);
} finally {
  await context.close();
  await browser.close();
}
