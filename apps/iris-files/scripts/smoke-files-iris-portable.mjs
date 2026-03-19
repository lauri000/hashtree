import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const distDir = path.join(appDir, 'dist');
const screenshotPath = path.join(appDir, 'test-results', 'files-iris-portable-smoke.png');

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
]);

function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream';
}

function safeJoin(rootDir, requestPath) {
  const normalized = requestPath === '/' ? '/index.html' : requestPath;
  const fullPath = path.resolve(rootDir, `.${normalized}`);
  if (!fullPath.startsWith(rootDir + path.sep) && fullPath !== path.join(rootDir, 'index.html')) {
    throw new Error(`Refusing to serve path outside root: ${requestPath}`);
  }
  return fullPath;
}

async function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const filePath = safeJoin(distDir, decodeURIComponent(requestUrl.pathname));
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
    url: `http://127.0.0.1:${address.port}/index.html#/`,
  };
}

async function main() {
  const { server, url } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const documentResponses = [];
  const pageErrors = [];
  const consoleErrors = [];

  page.on('response', (response) => {
    if (response.request().resourceType() === 'document') {
      documentResponses.push(response.url());
    }
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
    if (title !== 'Iris Files') {
      throw new Error(`Portable build loaded unexpected title "${title}"`);
    }

    if (documentResponses.length > 2) {
      throw new Error(`Portable build reloaded unexpectedly (${documentResponses.length} document responses)`);
    }

    const hasLogin = await page.getByRole('button', { name: /^Login$/ }).isVisible().catch(() => false);
    const headerText = (await page.locator('header').textContent().catch(() => '')).toLowerCase();
    const hasBrand = headerText.includes('iris') && headerText.includes('files');
    if (!hasBrand && !hasLogin) {
      const bodyPreview = (await page.locator('body').innerText()).slice(0, 500);
      throw new Error(`Portable build did not render the files shell. Body preview: ${bodyPreview}`);
    }

    if (pageErrors.length > 0) {
      throw new Error(`Portable build hit page errors:\n${pageErrors.join('\n')}`);
    }

    if (consoleErrors.length > 0) {
      throw new Error(`Portable build logged console errors:\n${consoleErrors.join('\n')}`);
    }

    console.log(`Portable Iris files smoke passed: ${url}`);
    console.log(`Screenshot: ${screenshotPath}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
