import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { sha256 } from '@noble/hashes/sha2.js';
import { nhashDecode, toHex } from '@hashtree/core';

const appDir = path.resolve(import.meta.dirname, '..');
const distDir = path.join(appDir, 'dist');
const screenshotPath = path.join(appDir, 'test-results', 'iris-sites-portable-smoke.png');
const ENSHITTIFIER_NHASH = 'nhash1qqsxyn0g6yyac8ruej7r7j80y2gx6ev5z5flu6ry5h5t3ajju5utzjs9yz7t3p2syr9n5heajlv85uwej232dk5x4zqe8d7ft67y3m5umxr55qjku38';
const ENSHITTIFIER_NPUB = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';
const textEncoder = new TextEncoder();

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream';
}

function safeJoin(rootDir, requestPath) {
  const normalizedPath = requestPath === '/' ? '/index.html' : requestPath;
  const fullPath = path.resolve(rootDir, `.${normalizedPath}`);
  if (!fullPath.startsWith(rootDir + path.sep) && fullPath !== path.join(rootDir, 'index.html')) {
    throw new Error(`Refusing to serve path outside root: ${requestPath}`);
  }
  return fullPath;
}

async function startServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://sites.iris.localhost');
    try {
      const filePath = safeJoin(rootDir, decodeURIComponent(requestUrl.pathname));
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': contentTypeFor(filePath),
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
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
    throw new Error('Failed to determine iris-sites smoke server address');
  }

  return {
    server,
    port: address.port,
  };
}

function installFakeWebSocket(context) {
  return context.addInitScript(() => {
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
      url = '';
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
}

function attachErrorCollection(page, errors) {
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.stack || error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
}

async function assertFrameShowsApp(page, timeoutMs) {
  const framedApp = page.frameLocator('iframe').getByText('Drop a MIDI file here');
  try {
    await framedApp.waitFor({ timeout: timeoutMs });
  } catch (error) {
    const frameSummaries = await Promise.all(page.frames().map(async (frame) => {
      let bodyText = '';
      try {
        if (frame !== page.mainFrame()) {
          bodyText = (await frame.locator('body').innerText({ timeout: 1000 })).slice(0, 200);
        }
      } catch {
        // Ignore frame body lookup failures in debug output.
      }
      return `${frame.url()} :: ${bodyText}`;
    }));
    const pageUrl = page.url();
    const iframeCount = await page.locator('iframe').count().catch(() => 0);
    throw new Error([
      error instanceof Error ? error.message : String(error),
      `page=${pageUrl}`,
      `iframes=${iframeCount}`,
      `frames=${frameSummaries.join(' | ')}`,
    ].join('\n'));
  }
}

function encodeBase32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }

  return output;
}

function encodeMutableHostLabel(npub, treeName) {
  return encodeBase32(sha256(textEncoder.encode(`mutable-host-v1\0${npub}\0${treeName}`)));
}

function immutableRuntimeHost(nhash, port) {
  const cid = nhashDecode(nhash);
  return {
    host: `http://${encodeBase32(cid.hash)}.sites.iris.localhost:${port}`,
    keyHex: cid.key ? toHex(cid.key) : '',
  };
}

function mutableRuntimeHost(npub, treeName, port) {
  return `http://${encodeMutableHostLabel(npub, treeName)}.sites.iris.localhost:${port}`;
}

const { server, port } = await startServer(distDir);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const pageErrors = [];

await installFakeWebSocket(context);

try {
  await mkdir(path.dirname(screenshotPath), { recursive: true });

  const launcherPage = await context.newPage();
  attachErrorCollection(launcherPage, pageErrors);
  const launcherUrl = `http://sites.iris.localhost:${port}/`;
  const launcherResponse = await launcherPage.goto(launcherUrl, { waitUntil: 'load', timeout: 60000 });
  if (!launcherResponse || launcherResponse.status() !== 200) {
    throw new Error(`Launcher page returned ${launcherResponse?.status() ?? 'no response'} for ${launcherUrl}`);
  }
  await launcherPage.locator('input[name="site-route"]').fill(`${ENSHITTIFIER_NPUB}/enshittifier`);
  await launcherPage.getByRole('button', { name: 'Launch' }).click();
  await launcherPage.waitForURL(`${mutableRuntimeHost(ENSHITTIFIER_NPUB, 'enshittifier', port)}/#/${ENSHITTIFIER_NPUB}/enshittifier/index.html`, { timeout: 60000 });
  await assertFrameShowsApp(launcherPage, 60000);

  const genericPage = await context.newPage();
  attachErrorCollection(genericPage, pageErrors);
  const genericUrl = `http://sites.iris.localhost:${port}/#/${ENSHITTIFIER_NHASH}/index.html`;
  const genericResponse = await genericPage.goto(genericUrl, { waitUntil: 'load', timeout: 60000 });
  if (!genericResponse || genericResponse.status() !== 200) {
    throw new Error(`Generic portal boot page returned ${genericResponse?.status() ?? 'no response'} for ${genericUrl}`);
  }
  const immutableRuntime = immutableRuntimeHost(ENSHITTIFIER_NHASH, port);
  await genericPage.waitForURL(`${immutableRuntime.host}/#/index.html?k=${immutableRuntime.keyHex}`, { timeout: 60000 });
  await assertFrameShowsApp(genericPage, 60000);
  const genericHref = genericPage.url();
  if (!genericHref.startsWith(immutableRuntime.host)) {
    throw new Error(`Expected keyless nhash runtime host, got ${genericHref}`);
  }
  if (genericHref.split('#')[0].includes(ENSHITTIFIER_NHASH)) {
    throw new Error(`Derived wildcard host leaked nhash outside hash fragment: ${genericHref}`);
  }

  const mutablePage = await context.newPage();
  attachErrorCollection(mutablePage, pageErrors);
  const mutableRouteSuffix = '?menu=0&reload=1';
  const mutableUrl = `http://sites.iris.localhost:${port}/#/${ENSHITTIFIER_NPUB}/enshittifier/index.html${mutableRouteSuffix}`;
  const mutableResponse = await mutablePage.goto(mutableUrl, { waitUntil: 'load', timeout: 60000 });
  if (!mutableResponse || mutableResponse.status() !== 200) {
    throw new Error(`Mutable portal boot page returned ${mutableResponse?.status() ?? 'no response'} for ${mutableUrl}`);
  }
  await mutablePage.waitForURL(`${mutableRuntimeHost(ENSHITTIFIER_NPUB, 'enshittifier', port)}/#/${ENSHITTIFIER_NPUB}/enshittifier/index.html${mutableRouteSuffix}`, { timeout: 60000 });
  const mutableHref = mutablePage.url();
  if (!mutableHref.startsWith(`${mutableRuntimeHost(ENSHITTIFIER_NPUB, 'enshittifier', port)}/#/${ENSHITTIFIER_NPUB}/enshittifier/index.html${mutableRouteSuffix}`)) {
    throw new Error(`Expected hashed mutable runtime host, got ${mutableHref}`);
  }
  if (mutableHref.includes('npub1') && mutableHref.split('#')[0].includes('npub1')) {
    throw new Error(`Mutable runtime host leaked npub outside hash fragment: ${mutableHref}`);
  }
  await assertFrameShowsApp(mutablePage, 60000);
  if (await mutablePage.locator('.runtime-menu-button').count()) {
    throw new Error(`Expected menu=0 launcher override to hide the runtime menu, got ${mutableHref}`);
  }

  const directImmutablePage = await context.newPage();
  attachErrorCollection(directImmutablePage, pageErrors);
  const directImmutableUrl = `${immutableRuntime.host}/#/index.html?k=${immutableRuntime.keyHex}`;
  const directImmutableResponse = await directImmutablePage.goto(directImmutableUrl, { waitUntil: 'load', timeout: 60000 });
  if (!directImmutableResponse || directImmutableResponse.status() !== 200) {
    throw new Error(`Direct immutable runtime returned ${directImmutableResponse?.status() ?? 'no response'} for ${directImmutableUrl}`);
  }
  await assertFrameShowsApp(directImmutablePage, 60000);
  await directImmutablePage.locator('.runtime-menu-button').waitFor({ state: 'visible', timeout: 60000 });
  await genericPage.screenshot({ path: screenshotPath, fullPage: true });

  if (pageErrors.length > 0) {
    throw new Error(`Iris Sites smoke hit browser errors:\n${pageErrors.join('\n')}`);
  }

  console.log(`Iris Sites portable smoke passed: ${genericUrl}`);
  console.log(`Screenshot: ${screenshotPath}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
