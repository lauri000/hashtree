import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const appDir = path.resolve(import.meta.dirname, '..');
const distDir = path.join(appDir, 'dist');
const screenshotPath = path.join(appDir, 'test-results', 'hashtree-cc-portable-smoke.png');
const prefix = '/portable';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream';
}

function safeJoin(rootDir, requestPath) {
  if (!requestPath.startsWith(prefix)) {
    throw new Error(`Unsupported portable path: ${requestPath}`);
  }
  const relativePath = requestPath.slice(prefix.length) || '/index.html';
  const normalized = relativePath === '/' ? '/index.html' : relativePath;
  const fullPath = path.resolve(rootDir, `.${normalized}`);
  if (!fullPath.startsWith(rootDir + path.sep) && fullPath !== path.join(rootDir, 'index.html')) {
    throw new Error(`Refusing to serve path outside root: ${requestPath}`);
  }
  return fullPath;
}

async function startServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? `${prefix}/`, 'http://127.0.0.1');
      const filePath = safeJoin(rootDir, decodeURIComponent(requestUrl.pathname));
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': contentTypeFor(filePath),
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : 'not found');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to determine portable smoke server address');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}${prefix}/index.html#/dev`,
  };
}

const { server, url } = await startServer(distDir);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
const consoleErrors = [];

await page.addInitScript(() => {
  class FakeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    CONNECTING = FakeWebSocket.CONNECTING;
    OPEN = FakeWebSocket.OPEN;
    CLOSING = FakeWebSocket.CLOSING;
    CLOSED = FakeWebSocket.CLOSED;
    binaryType = 'blob';
    bufferedAmount = 0;
    extensions = '';
    protocol = '';
    readyState = FakeWebSocket.CONNECTING;
    url;
    onopen = null;
    onclose = null;
    onerror = null;
    onmessage = null;

    constructor(url) {
      super();
      this.url = String(url);
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        const event = new Event('open');
        this.dispatchEvent(event);
        this.onopen?.(event);
      });
    }

    send(_data) {}

    close(code = 1000, reason = '') {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      const event = new CloseEvent('close', { code, reason, wasClean: true });
      this.dispatchEvent(event);
      this.onclose?.(event);
    }
  }

  Object.defineProperty(window, 'WebSocket', {
    value: FakeWebSocket,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    value: FakeWebSocket,
    configurable: true,
    writable: true,
  });
});

page.on('pageerror', (error) => {
  pageErrors.push(error.stack || error.message);
});
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text());
  }
});

try {
  const response = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  if (!response || response.status() !== 200) {
    throw new Error(`Portable build returned ${response?.status() ?? 'no response'} for ${url}`);
  }

  await page.waitForTimeout(3000);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const title = await page.title();
  if (title !== 'hashtree - share privately') {
    throw new Error(`Portable build loaded unexpected title "${title}"`);
  }

  await page.getByText('Case Study: hashtree.cc').waitFor({ timeout: 15000 });

  const caseStudyImageLoaded = await page
    .locator('img[alt="hashtree.cc"]')
    .evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0);
  if (!caseStudyImageLoaded) {
    throw new Error('Portable build did not load the hashtree.cc case-study image');
  }

  const filesSlideLoaded = await page
    .locator('img[alt="Iris Files"]').first()
    .evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0);
  if (!filesSlideLoaded) {
    throw new Error('Portable build did not load the carousel screenshot assets');
  }

  if (pageErrors.length > 0) {
    throw new Error(`Portable build hit page errors:\n${pageErrors.join('\n')}`);
  }

  if (consoleErrors.length > 0) {
    throw new Error(`Portable build logged console errors:\n${consoleErrors.join('\n')}`);
  }

  console.log(`Portable hashtree.cc smoke passed: ${url}`);
  console.log(`Screenshot: ${screenshotPath}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
