/**
 * E2E tests for HTML file viewing with sites.iris.to handoff.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { setupPageErrorHandler, navigateToPublicFolder, disableOthersPool, useLocalRelay } from './test-utils.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function ensureFolderView(page: Page) {
  const fileList = page.locator('[data-testid="file-list"]');
  const backToFolder = page.getByRole('link', { name: 'Back to folder' });
  if (await backToFolder.isVisible().catch(() => false)) {
    await backToFolder.click({ force: true });
  } else {
    try {
      await backToFolder.waitFor({ state: 'visible', timeout: 2000 });
      await backToFolder.click({ force: true });
    } catch {
      // No-op: we stayed in folder view.
    }
  }
  await expect(fileList).toBeVisible({ timeout: 10000 });
  await expect(backToFolder).toBeHidden({ timeout: 10000 });
}

test.describe('HTML file viewing', () => {
  test('should show HTML source normally and keep an Open Site link in the header', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await navigateToPublicFolder(page);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-test-'));
    const cssPath = path.join(tmpDir, 'style.css');
    const htmlPath = path.join(tmpDir, 'index.html');

    try {
      fs.writeFileSync(cssPath, 'body { background: rgb(0, 128, 0); }');
      fs.writeFileSync(htmlPath, `<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Hello from HashTree</h1>
</body>
</html>`);

      await page.locator('header a:has-text("Iris")').click();
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: 'New Folder' }).click();

      const input = page.locator('input[placeholder="Folder name..."]');
      await input.waitFor({ timeout: 5000 });
      await input.fill('html-test');
      await page.click('button:has-text("Create")');

      await expect(page.locator('.fixed.inset-0.bg-black')).not.toBeVisible({ timeout: 10000 });
      await expect(page.getByText(/Drop or click to add|Empty directory/).first()).toBeVisible({ timeout: 10000 });

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(cssPath);
      await ensureFolderView(page);
      await expect(page.locator('[data-testid="file-list"] a:has-text("style.css")')).toBeVisible({ timeout: 10000 });

      await fileInput.setInputFiles(htmlPath);
      await ensureFolderView(page);
      await expect(page.locator('[data-testid="file-list"] a:has-text("index.html")')).toBeVisible({ timeout: 10000 });

      const directoryOpenSite = page.getByTestId('directory-open-site');
      await expect(directoryOpenSite).toBeVisible({ timeout: 10000 });
      await expect(directoryOpenSite).toHaveAttribute('href', /https:\/\/sites\.iris\.to\/#\//);
      await expect(directoryOpenSite).toHaveAttribute('href', /html-test\/index\.html\?reload=1$/);

      await page.locator('[data-testid="file-list"] a:has-text("index.html")').click();

      await expect(page.getByTestId('html-site-handoff')).toHaveCount(0);
      await expect(page.locator('iframe')).toHaveCount(0);

      const viewerOpenSite = page.getByTestId('viewer-open-site');
      await expect(viewerOpenSite).toBeVisible({ timeout: 10000 });
      const viewerHref = await viewerOpenSite.getAttribute('href');
      expect(viewerHref).toMatch(/https:\/\/sites\.iris\.to\/#\//);
      expect(viewerHref).toMatch(/html-test\/index\.html\?reload=1$/);

      const codeViewer = page.locator('pre.code-viewer');
      await expect(codeViewer).toBeVisible({ timeout: 10000 });
      await expect(codeViewer).toContainText('<h1>Hello from HashTree</h1>');
      await expect(codeViewer).toContainText('<link rel="stylesheet" href="style.css">');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should show app-style HTML source and keep an Open Site link in the header', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await disableOthersPool(page);
    await useLocalRelay(page);
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    const appDir = `absolute-app-${Date.now()}`;
    const files = [
      {
        relativePath: `${appDir}/index.html`,
        content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Absolute Assets App</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
  <h1>Absolute Assets App</h1>
  <div id="status">Loading...</div>
  <img id="logo" src="/assets/logo.png" alt="logo">
  <script src="/assets/app.js"></script>
</body>
</html>`,
        type: 'text/html',
      },
      { relativePath: `${appDir}/assets/app.css`, content: 'body { background: rgb(12, 34, 56); }', type: 'text/css' },
      { relativePath: `${appDir}/assets/app.js`, content: 'window.__loaded = true;', type: 'application/javascript' },
      {
        relativePath: `${appDir}/assets/logo.png`,
        content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
        type: 'image/png',
        encoding: 'base64',
      },
    ];

    await page.evaluate(async (payload) => {
      const { uploadFilesWithPaths } = await import('/src/stores/upload.ts');
      const filesWithPaths = payload.map((entry) => {
        const name = entry.relativePath.split('/').pop() || 'file';
        const data = entry.encoding === 'base64'
          ? Uint8Array.from(atob(entry.content), (c) => c.charCodeAt(0))
          : entry.content;
        const file = new File([data], name, { type: entry.type });
        return { file, relativePath: entry.relativePath };
      });
      await uploadFilesWithPaths(filesWithPaths);
    }, files);

    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: appDir }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });

    const url = page.url();
    const npubMatch = url.match(/npub1[a-z0-9]+/);
    expect(npubMatch).toBeTruthy();
    const targetPath = `${npubMatch![0]}/public/${appDir}/index.html`;

    const searchInput = page.locator('input[type="search"], input[placeholder*="Search"]').first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill(targetPath);
    await searchInput.press('Enter');

    await page.waitForURL(new RegExp(`${appDir}.*index\\.html`), { timeout: 15000 });

    await expect(page.getByTestId('html-site-handoff')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);

    const viewerOpenSite = page.getByTestId('viewer-open-site');
    await expect(viewerOpenSite).toBeVisible({ timeout: 10000 });
    await expect(viewerOpenSite).toHaveAttribute('href', new RegExp(`${appDir}\\/index\\.html\\?reload=1$`));

    const codeViewer = page.locator('pre.code-viewer');
    await expect(codeViewer).toBeVisible({ timeout: 10000 });
    await expect(codeViewer).toContainText('<title>Absolute Assets App</title>');
    await expect(codeViewer).toContainText('<script src="/assets/app.js"></script>');
  });
});
