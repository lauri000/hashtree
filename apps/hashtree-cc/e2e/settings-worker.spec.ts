import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

test('settings page exposes connectivity toggle and persists server/storage settings', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('connectivity-indicator')).toBeVisible();

  await page.getByTestId('nav-settings').click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByTestId('settings-page')).toBeVisible();

  const showConnectivity = page.getByTestId('settings-show-connectivity');
  await showConnectivity.uncheck();
  await expect(page.getByTestId('connectivity-indicator')).toHaveCount(0);
  await showConnectivity.check();
  await expect(page.getByTestId('connectivity-indicator')).toBeVisible();

  const storageLimit = page.getByTestId('settings-storage-limit-mb');
  await storageLimit.fill('2048');
  await storageLimit.blur();
  await expect(storageLimit).toHaveValue('2048');

  const serverUrl = 'https://files.example.test';
  await page.getByTestId('settings-new-server').fill(serverUrl);
  await page.getByTestId('settings-add-server').click();
  await expect(page.getByTestId('settings-server-item').filter({ hasText: 'files.example.test' })).toBeVisible();

  await page.goto('/#/dev');
  await page.getByTestId('nav-settings').click();
  await expect(storageLimit).toHaveValue('2048');
  await expect(page.getByTestId('settings-server-item').filter({ hasText: 'files.example.test' })).toBeVisible();
});

test('uploaded file stays viewable after reload without blossom GET fallback', async ({ page }) => {
  const fileContent = 'worker cache persistence';
  const expectedHash = createHash('sha256').update(fileContent).digest('hex');
  let getRequests = 0;

  await page.route('https://*/upload', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sha256: expectedHash, size: fileContent.length }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(`https://*/${expectedHash}**`, async (route) => {
    if (route.request().method() === 'HEAD') {
      await route.fulfill({ status: 404 });
      return;
    }
    if (route.request().method() === 'GET') {
      getRequests += 1;
      await route.fulfill({
        status: 500,
        contentType: 'text/plain',
        body: 'offline',
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({
    name: 'persist.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(fileContent),
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('viewer-text')).toContainText(fileContent);

  const viewerUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(viewerUrl);

  await expect(page.getByTestId('viewer-text')).toContainText(fileContent, { timeout: 10000 });
  expect(getRequests).toBe(0);
});
