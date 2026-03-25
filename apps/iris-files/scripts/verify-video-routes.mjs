import { chromium, webkit } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4175/index.html';
const requestedBrowsers = new Set(
  (process.env.VERIFY_BROWSERS ?? 'chromium,webkit')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

const routes = [
  ['B Sirius Baby', '#/npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk/videos%2FB%20Sirius%20Baby'],
  ['Mine Bombers', '#/npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk/videos%2FMine%20Bombers%20in-game%20music'],
  ['Bell ringing', '#/npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk/videos%2F15%2C684kg%20Bell%20ringing'],
];

function routeUrl(hash) {
  return hash.startsWith('http://') || hash.startsWith('https://') ? hash : `${baseUrl}${hash}`;
}

async function waitForPlayableVideo(page) {
  return await page.waitForFunction(() => {
    const bodyText = document.body?.innerText ?? '';
    if (/Video file not found|Video failed to load|Daemon not started yet/i.test(bodyText)) return true;
    const video = document.querySelector('video[controls]');
    return !!video && !!(video.currentSrc || video.src) && video.readyState >= 2;
  }, undefined, { timeout: 45000 }).then(() => true).catch(() => false);
}

async function captureRouteState(page) {
  return await page.evaluate(() => {
    const video = document.querySelector('video[controls]');
    const container = document.querySelector('[data-video-src]');
    const bodyText = document.body?.innerText ?? '';
    const errorText = /Video file not found|Video failed to load|Daemon not started yet/i.exec(bodyText)?.[0] ?? null;
    return {
      href: location.href,
      hasWorker: !!window.__getWorkerAdapter?.(),
      hasServiceWorkerController: !!navigator.serviceWorker?.controller,
      errorText,
      container: container ? {
        videoSrc: container.getAttribute('data-video-src'),
        videoFilename: container.getAttribute('data-video-filename'),
        videoTreeName: container.getAttribute('data-video-tree-name'),
        videoLoadRuns: container.getAttribute('data-video-load-runs'),
      } : null,
      video: video ? {
        src: video.currentSrc || video.src,
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        error: video.error ? { code: video.error.code, message: video.error.message || null } : null,
      } : null,
    };
  });
}

async function probeCurrentVideoFetch(page) {
  return await page.evaluate(async () => {
    const container = document.querySelector('[data-video-src]');
    const rawSrc = container?.getAttribute('data-video-src');
    if (!rawSrc) return null;
    const url = new URL(rawSrc, window.location.href).toString();
    const started = performance.now();
    try {
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
        cache: 'no-store',
      });
      const body = await response.arrayBuffer();
      return {
        url,
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type'),
        contentRange: response.headers.get('content-range'),
        contentLength: response.headers.get('content-length'),
        bytes: body.byteLength,
        elapsedMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      return {
        url,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Math.round(performance.now() - started),
      };
    }
  });
}

async function captureRecentsState(page) {
  await page.goto(routeUrl('#/'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h2'));
    const recentHeading = headings.find((el) => el.textContent?.trim() === 'Recent');
    const section = recentHeading?.closest('section') ?? recentHeading?.parentElement?.parentElement ?? null;
    const cards = section ? Array.from(section.querySelectorAll('a')).slice(0, 6) : [];

    return {
      hasRecentSection: !!recentHeading,
      cards: cards.map((card) => {
        const thumb = card.querySelector('.aspect-video');
        const img = thumb?.querySelector('img') ?? null;
        const placeholder = !!thumb?.querySelector('.i-lucide-video');
        return {
          text: card.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120) ?? '',
          imgSrc: img?.currentSrc ?? null,
          naturalWidth: img?.naturalWidth ?? 0,
          placeholder,
        };
      }),
    };
  });
}

const screenshots = [];

const browserTargets = [['chromium', chromium], ['webkit', webkit]]
  .filter(([browserName]) => requestedBrowsers.has(browserName));

if (browserTargets.length === 0) {
  throw new Error(`No matching browsers requested via VERIFY_BROWSERS=${process.env.VERIFY_BROWSERS ?? ''}`);
}

for (const [browserName, browserType] of browserTargets) {
  const browser = await browserType.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const results = [];
  const consoleMessages = [];

  page.on('console', (message) => {
    if (consoleMessages.length >= 100) return;
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
    });
  });

  for (const [label, hash] of routes) {
    const started = Date.now();
    await page.goto(routeUrl(hash), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const ready = await waitForPlayableVideo(page);
    const state = await captureRouteState(page);
    const fetchProbe = await probeCurrentVideoFetch(page);
    const debugLog = await page.evaluate(() => {
      const entries = Array.isArray(window.__HTREE_DEBUG_LOG__) ? window.__HTREE_DEBUG_LOG__ : [];
      return entries.slice(-40);
    });
    results.push({
      label,
      elapsedMs: Date.now() - started,
      ready,
      ...state,
      fetchProbe,
      debugLog,
    });
  }

  const routeScreenshot = `/Users/sirius/src/hashtree/tmp/screens/verify-routes-${browserName}.png`;
  await page.screenshot({ path: routeScreenshot, fullPage: true });
  screenshots.push(routeScreenshot);

  const recents = await captureRecentsState(page);
  const recentsScreenshot = `/Users/sirius/src/hashtree/tmp/screens/verify-recents-${browserName}.png`;
  await page.screenshot({ path: recentsScreenshot, fullPage: true });
  screenshots.push(recentsScreenshot);

  console.log(JSON.stringify({
    browser: browserName,
    routeScreenshot,
    recentsScreenshot,
    results,
    recents,
    consoleMessages,
  }, null, 2));

  await browser.close();
}

console.log(JSON.stringify({ screenshots }, null, 2));
