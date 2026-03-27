import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const ORIGIN = args[0] ?? 'https://video.iris.to/';
const DAEMON = args[1] ?? 'http://127.0.0.1:21417';
const OUT_DIR = path.resolve(import.meta.dirname, '..', 'test-results');
const JSON_PATH = path.join(OUT_DIR, 'feed-thumbnail-audit.json');
const SCREENSHOT_PATH = path.join(OUT_DIR, 'feed-thumbnail-audit.png');

const THUMB_FILENAMES = ['thumbnail.jpg', 'thumbnail.webp', 'thumbnail.png', 'thumbnail.jpeg'];
const FETCH_TIMEOUT_MS = 2000;
const CLASSIFY_CONCURRENCY = 6;
const APP_SETTLE_MS = 10000;

function parseHref(href) {
  if (!href || !href.startsWith('#/')) return null;
  const parts = href.slice(2).split('/').map((part) => decodeURIComponent(part));
  if (parts.length < 2 || !parts[0].startsWith('npub1')) return null;
  return {
    npub: parts[0],
    treeName: parts[1],
    videoId: parts[2] ?? null,
  };
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetchWithTimeout(url);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return await response.json();
}

async function fetchText(url) {
  let response;
  try {
    response = await fetchWithTimeout(url);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return await response.text();
}

async function headOk(url) {
  try {
    const response = await fetchWithTimeout(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

async function classifyTree(card) {
  if (card.hasGeneratedPoster) {
    return {
      resolve: 'skipped_loaded',
      source: 'dom_generated_poster',
    };
  }

  if (card.currentSrc && card.complete && (card.naturalWidth ?? 0) > 0) {
    const normalized = String(card.currentSrc);
    if (/\/htree\/nhash1[^/?]+\/thumbnail\.(jpg|jpeg|png|webp)(\?|$)/i.test(normalized)) {
      return { resolve: 'skipped_loaded', source: 'dom_exact_immutable_thumbnail_file' };
    }
    if (/\/htree\/nhash1[^/?]+(\?|$)/i.test(normalized)) {
      return { resolve: 'skipped_loaded', source: 'dom_exact_immutable_thumbnail_ref' };
    }
    if (/\/htree\/npub1[^/]+\/[^?]+\/thumbnail(\?|$)/i.test(normalized)) {
      return { resolve: 'skipped_loaded', source: 'dom_mutable_thumbnail_alias' };
    }

    return {
      resolve: 'skipped_loaded',
      source: 'dom_loaded_img',
      sourceDetail: normalized,
    };
  }

  if (card.videoSrc && (card.videoReadyState ?? 0) >= 2 && (card.videoWidth ?? 0) > 0) {
    return {
      resolve: 'skipped_loaded',
      source: 'dom_loaded_video',
      sourceDetail: String(card.videoSrc),
    };
  }

  const parsed = parseHref(card.href);
  if (!parsed) {
    return { resolve: 'invalid_href', source: 'invalid_href' };
  }

  const resolveUrl = `${DAEMON}/api/resolve/${parsed.npub}/${encodeURIComponent(parsed.treeName)}`;
  const resolved = await fetchJson(resolveUrl);
  if (!resolved?.hash) {
    return {
      resolve: 'failed',
      source: 'unresolved',
      resolveError: resolved?.error ?? 'resolve_failed',
    };
  }

  const baseTreeUrl = `${DAEMON}/htree/${parsed.npub}/${encodeURIComponent(parsed.treeName)}`;
  const rootThumbChecks = await Promise.all(
    THUMB_FILENAMES.map(async (name) => ({
      name,
      ok: await headOk(`${baseTreeUrl}/${encodeURIComponent(name)}`),
    }))
  );
  const rootThumb = rootThumbChecks.find((entry) => entry.ok);
  if (rootThumb) {
    return {
      resolve: 'ok',
      source: 'root_thumbnail_file',
      sourceDetail: rootThumb.name,
      hash: resolved.hash,
    };
  }

  for (const metadataName of ['metadata.json', 'info.json']) {
    const text = await fetchText(`${baseTreeUrl}/${metadataName}`);
    if (!text) continue;
    try {
      const json = JSON.parse(text);
      if (typeof json.thumbnail === 'string' && json.thumbnail.trim()) {
        const value = json.thumbnail.trim();
        if (value.startsWith('nhash1')) {
          return {
            resolve: 'ok',
            source: 'metadata_thumbnail_nhash',
            sourceDetail: `${metadataName}:${value}`,
            hash: resolved.hash,
          };
        }

        const name = value.split('/').filter(Boolean).at(-1);
        if (name && await headOk(`${baseTreeUrl}/${encodeURIComponent(name)}`)) {
          return {
            resolve: 'ok',
            source: 'metadata_thumbnail_file_ref',
            sourceDetail: `${metadataName}:${name}`,
            hash: resolved.hash,
          };
        }

        return {
          resolve: 'ok',
          source: 'metadata_thumbnail_unresolved_ref',
          sourceDetail: `${metadataName}:${value}`,
          hash: resolved.hash,
        };
      }
    } catch {
      // ignore malformed metadata
    }
  }

  if (await headOk(`${baseTreeUrl}/thumbnail`)) {
    return {
      resolve: 'ok',
      source: 'alias_or_child_fallback',
      sourceDetail: 'thumbnail',
      hash: resolved.hash,
    };
  }

  return {
    resolve: 'ok',
    source: 'no_discoverable_thumbnail',
    hash: resolved.hash,
  };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });

try {
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(APP_SETTLE_MS);

  let stablePasses = 0;
  let lastCardCount = 0;
  for (let i = 0; i < 30; i += 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    const cardCount = await page.evaluate(() =>
      document.querySelectorAll('div.grid a[href^="#/npub"]').length
    );
    if (cardCount === lastCardCount) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
      lastCardCount = cardCount;
    }
    if (stablePasses >= 2) break;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(3000);

  const cards = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('div.grid a[href^="#/npub"]'));
    const deduped = new Map();
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href');
      if (!href || deduped.has(href)) continue;
      const media = anchor.querySelector('.video-thumb, .playlist-thumb');
      const img = media?.querySelector('img') ?? null;
      const video = media?.querySelector('video') ?? null;
      const placeholder = !!media?.querySelector('[data-testid="media-placeholder"]');
      const generatedPoster = !!media?.querySelector('[data-testid="generated-thumbnail-poster"]');
      const text = (anchor.textContent || '').trim().replace(/\s+/g, ' ');
      deduped.set(href, {
        href,
        text,
        imgSrc: img?.getAttribute('src') ?? null,
        currentSrc: img?.currentSrc ?? null,
        complete: img?.complete ?? null,
        naturalWidth: img?.naturalWidth ?? null,
        naturalHeight: img?.naturalHeight ?? null,
        videoSrc: video?.getAttribute('src') ?? null,
        videoReadyState: video?.readyState ?? null,
        videoWidth: video?.videoWidth ?? null,
        videoHeight: video?.videoHeight ?? null,
        hasPlaceholder: placeholder,
        hasGeneratedPoster: generatedPoster,
        hasMediaContainer: !!media,
      });
    }
    return Array.from(deduped.values());
  });

  const audited = [];
  for (let i = 0; i < cards.length; i += CLASSIFY_CONCURRENCY) {
    const batch = cards.slice(i, i + CLASSIFY_CONCURRENCY);
    const classified = await Promise.all(batch.map(async (card) => ({
      ...card,
      ...(await classifyTree(card)),
      domStatus: (card.currentSrc && card.complete && (card.naturalWidth ?? 0) > 0)
        || card.hasGeneratedPoster
        || (card.videoSrc && (card.videoReadyState ?? 0) >= 2 && (card.videoWidth ?? 0) > 0)
        ? 'loaded'
        : card.hasPlaceholder
          ? 'placeholder'
          : (card.imgSrc || card.videoSrc)
            ? 'broken_img'
            : 'no_img',
    })));
    audited.push(...classified);
  }

  const summary = {
    origin: ORIGIN,
    cardCount: audited.length,
    loaded: audited.filter((item) => item.domStatus === 'loaded').length,
    placeholders: audited.filter((item) => item.domStatus === 'placeholder').length,
    brokenImg: audited.filter((item) => item.domStatus === 'broken_img').length,
    noImg: audited.filter((item) => item.domStatus === 'no_img').length,
    notLoaded: audited.filter((item) => item.domStatus !== 'loaded').length,
    resolveFailures: audited.filter((item) => !['ok', 'skipped_loaded'].includes(item.resolve)).length,
    bySource: Object.fromEntries(
      Array.from(
        audited.reduce((map, item) => {
          map.set(item.source, (map.get(item.source) ?? 0) + 1);
          return map;
        }, new Map())
      ).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    ),
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify({ summary, cards: audited }, null, 2));
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

  console.log(JSON.stringify({ summary, json: JSON_PATH, screenshot: SCREENSHOT_PATH }, null, 2));
} finally {
  await browser.close();
}
