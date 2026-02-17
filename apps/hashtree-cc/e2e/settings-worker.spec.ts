import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

test('settings page persists storage/server settings and allows relay updates', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('connectivity-indicator')).toBeVisible();
  await page.goto('/#/settings');
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect(page.getByTestId('settings-blossom-link')).toHaveAttribute('href', 'https://github.com/hzrd149/blossom');
  await expect(page.getByRole('link', { name: 'Share Privately' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'For Developers' })).toHaveCount(0);

  const storageLimit = page.getByTestId('settings-storage-limit-mb');
  await storageLimit.fill('2048');
  await storageLimit.blur();
  await expect(storageLimit).toHaveValue('2048');

  const serverUrl = 'https://files.example.test';
  await page.getByTestId('settings-new-server').fill(serverUrl);
  await page.getByTestId('settings-add-server').click();
  await expect(page.getByTestId('settings-server-item').filter({ hasText: 'files.example.test' })).toBeVisible();

  await page.getByTestId('settings-new-relay').fill('wss://relay.example.test');
  await page.getByTestId('settings-add-relay').click();
  await expect(page.getByTestId('settings-relay-item').filter({ hasText: 'relay.example.test' })).toBeVisible();

  await page.goto('/#/settings');
  await expect(storageLimit).toHaveValue('2048');
  await expect(page.getByTestId('settings-server-item').filter({ hasText: 'files.example.test' })).toBeVisible();
  await expect(page.getByTestId('settings-relay-item').filter({ hasText: 'relay.example.test' })).toBeVisible();
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

test('p2p module is initialized in hashtree-cc', async ({ page }) => {
  await page.goto('/');

  await expect.poll(async () => page.evaluate(() => {
    const state = (window as unknown as { __hashtreeCcP2P?: { started: boolean } }).__hashtreeCcP2P;
    return state?.started ?? false;
  })).toBe(true);

  const p2pState = await page.evaluate(() => {
    const state = (window as unknown as { __hashtreeCcP2P?: { started: boolean; peerCount: number } }).__hashtreeCcP2P;
    return {
      started: state?.started ?? false,
      peerCount: state?.peerCount ?? -1,
    };
  });

  expect(p2pState.started).toBe(true);
  expect(p2pState.peerCount).toBeGreaterThanOrEqual(0);
});
