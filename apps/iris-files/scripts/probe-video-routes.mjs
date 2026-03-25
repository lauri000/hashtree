import { chromium } from '@playwright/test';

const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:4175/index.html';
const ROUTES = [
  ['B Sirius Baby', '#/npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk/videos%2FB%20Sirius%20Baby'],
  ['Mine Bombers', '#/npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk/videos%2FMine%20Bombers%20in-game%20music'],
  ['Bell ringing', '#/npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk/videos%2F15%2C684kg%20Bell%20ringing'],
  ['B Sirius Baby live', 'https://video.iris.to/#/npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk/videos%2FB%20Sirius%20Baby'],
];

function routeUrl(base, hash) {
  if (hash.startsWith('http://') || hash.startsWith('https://')) return hash;
  return `${base}${base.includes('?') ? '&' : '?'}debug=1${hash}`;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });

for (const [name, hash] of ROUTES) {
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (consoleMessages.length >= 60) return;
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });

  page.on('pageerror', (error) => {
    if (pageErrors.length >= 20) return;
    pageErrors.push(String(error));
  });

  page.on('requestfailed', (request) => {
    if (failedRequests.length >= 30) return;
    failedRequests.push({
      url: request.url(),
      failure: request.failure()?.errorText ?? null,
      resourceType: request.resourceType(),
    });
  });

  const url = routeUrl(ORIGIN, hash);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(25000);

  const state = await page.evaluate(() => {
    const video = document.querySelector('video');
    const errorNode = Array.from(document.querySelectorAll('*')).find((el) => /Video file not found|Video failed to load/i.test(el.textContent || ''));
    const debugLog = Array.isArray(window.__HTREE_DEBUG_LOG__) ? window.__HTREE_DEBUG_LOG__.slice(-40) : [];
    return {
      href: location.href,
      title: document.title,
      hasWorkerAdapter: !!window.__getWorkerAdapter?.(),
      hasServiceWorkerController: !!navigator.serviceWorker?.controller,
      errorText: errorNode?.textContent?.trim() ?? null,
      debugLog,
      video: video ? {
        currentSrc: video.currentSrc || video.src,
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        ended: video.ended,
        error: video.error ? {
          code: video.error.code,
          message: video.error.message || null,
        } : null,
      } : null,
    };
  });

  const screenshot = `/Users/sirius/src/hashtree/tmp/screens/${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ name, screenshot, state, consoleMessages, pageErrors, failedRequests }));
  await page.close();
}

await browser.close();
