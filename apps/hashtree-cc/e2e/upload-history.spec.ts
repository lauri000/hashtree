import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

function mockBlossom(page: import('@playwright/test').Page, expectedHash: string, content: string | Buffer) {
  return Promise.all([
    page.route('https://*/upload', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sha256: expectedHash, size: content.length }),
        });
      } else {
        await route.continue();
      }
    }),
    page.route(`https://*/${expectedHash}**`, async (route) => {
      if (route.request().method() === 'HEAD') {
        await route.fulfill({ status: 404 });
      } else if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/octet-stream',
          body: Buffer.from(content),
        });
      } else {
        await route.continue();
      }
    }),
  ]);
}

test('upload history appears after file upload and persists on navigation back', async ({ page }) => {
  const fileContent = 'history test file';
  const expectedHash = createHash('sha256').update(fileContent).digest('hex');

  await mockBlossom(page, expectedHash, fileContent);
  await page.goto('/');

  // No history initially
  await expect(page.getByTestId('upload-history')).not.toBeVisible();

  // Upload a file
  await page.getByTestId('file-input').setInputFiles({
    name: 'history-test.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(fileContent),
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });

  // Navigate back to share page
  await page.goBack();
  await expect(page.getByTestId('drop-zone')).toBeVisible();

  // History entry should be visible
  await expect(page.getByTestId('upload-history')).toBeVisible();
  await expect(page.getByTestId('upload-history-entry')).toBeVisible();
  await expect(page.getByTestId('upload-history-link')).toContainText('history-test.txt');
});

test('upload history entry can be deleted', async ({ page }) => {
  const fileContent = 'delete test file';
  const expectedHash = createHash('sha256').update(fileContent).digest('hex');

  await mockBlossom(page, expectedHash, fileContent);
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles({
    name: 'delete-me.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(fileContent),
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });
  await page.goBack();
  await expect(page.getByTestId('upload-history')).toBeVisible();

  // Delete the entry
  await page.getByTestId('upload-history-remove').click();
  await expect(page.getByTestId('upload-history')).not.toBeVisible();
});

test('upload history clear all removes all entries', async ({ page }) => {
  // Seed two entries in localStorage
  await page.addInitScript(() => {
    window.localStorage.setItem('hashtree-cc-uploads', JSON.stringify([
      { nhash: 'aaa', fileName: 'file1.txt', size: 100, uploadedAt: Date.now() - 1000 },
      { nhash: 'bbb', fileName: 'file2.txt', size: 200, uploadedAt: Date.now() - 2000 },
    ]));
  });

  await page.goto('/');
  await expect(page.getByTestId('upload-history')).toBeVisible();
  await expect(page.getByTestId('upload-history-entry')).toHaveCount(2);

  await page.getByTestId('upload-history-clear').click();
  await expect(page.getByTestId('upload-history')).not.toBeVisible();
});

test('text upload also records history entry', async ({ page }) => {
  const text = 'pastebin history test';
  const expectedHash = createHash('sha256').update(text).digest('hex');

  await mockBlossom(page, expectedHash, text);
  await page.goto('/');

  await page.getByTestId('text-input').fill(text);
  await page.getByTestId('text-save').click();

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });
  await page.goBack();
  await expect(page.getByTestId('upload-history')).toBeVisible();
  await expect(page.getByTestId('upload-history-link')).toContainText('text.txt');
});
