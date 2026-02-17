import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const SAVE_WITH_ENTER = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';

test('page loads with Share Privately tab active', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('drop-zone')).toBeVisible();
  await expect(page.getByText('Drop files or browse')).toBeVisible();
});

test('can switch tabs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('drop-zone')).toBeVisible();

  await page.getByText('For Developers').click();
  await expect(page.getByText('Git without GitHub')).toBeVisible();
  await expect(page.getByTestId('drop-zone')).not.toBeVisible();

  await page.getByText('Share Privately').click();
  await expect(page.getByTestId('drop-zone')).toBeVisible();
});

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

test('file upload navigates to viewer with nhash URL', async ({ page }) => {
  const fileContent = 'hello hashtree test file';
  const expectedHash = createHash('sha256').update(fileContent).digest('hex');

  await mockBlossom(page, expectedHash, fileContent);
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles({
    name: 'test.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(fileContent),
  });

  // Should navigate directly to viewer after upload
  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });

  // URL has nhash and filename
  expect(page.url()).toContain('#/nhash1');
  expect(page.url()).toContain('/test.txt');

  // Text content is shown
  await expect(page.getByTestId('viewer-text')).toBeVisible();
  await expect(page.getByTestId('viewer-text')).toContainText('hello hashtree test file');
});

test('viewer has copy link button', async ({ page, context }) => {
  const fileContent = 'copy test file';
  const expectedHash = createHash('sha256').update(fileContent).digest('hex');

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockBlossom(page, expectedHash, fileContent);
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles({
    name: 'copy-test.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(fileContent),
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });

  // Click copy link in the viewer
  await page.getByText('Copy Link').click();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain('nhash1');
  expect(clipboardText).toContain('/copy-test.txt');
});

test('nhash URL shows image viewer', async ({ page }) => {
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64'
  );
  const expectedHash = createHash('sha256').update(pngBytes).digest('hex');

  await mockBlossom(page, expectedHash, pngBytes);

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('viewer-image')).toBeVisible();
  await expect.poll(async () => page.getByTestId('viewer-image').getAttribute('src')).toContain('/htree/');
  const src = await page.getByTestId('viewer-image').getAttribute('src');
  expect(src).not.toContain('blob:');
});

test('nhash URL shows download for unknown type', async ({ page }) => {
  const fileContent = Buffer.from('binary-stuff');
  const expectedHash = createHash('sha256').update(fileContent).digest('hex');

  await mockBlossom(page, expectedHash, fileContent);

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({
    name: 'data.bin',
    mimeType: 'application/octet-stream',
    buffer: fileContent,
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('viewer-download')).toBeVisible();
});

test('browser back returns to upload page', async ({ page }) => {
  const fileContent = 'nav test';
  const expectedHash = createHash('sha256').update(fileContent).digest('hex');

  await mockBlossom(page, expectedHash, fileContent);
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles({
    name: 'nav.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(fileContent),
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });

  await page.goBack();
  await expect(page.getByTestId('drop-zone')).toBeVisible();
});

// --- Pastebin / Text Editor tests ---

function mockBlossomMulti(page: import('@playwright/test').Page) {
  // Mock that accepts any hash - useful when we don't know the hash ahead of time (e.g. after editing)
  return Promise.all([
    page.route('https://*/upload', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sha256: 'mock', size: 0 }),
        });
      } else {
        await route.continue();
      }
    }),
    page.route(/https:\/\/[^/]+\/[0-9a-f]{64}/, async (route) => {
      if (route.request().method() === 'HEAD') {
        await route.fulfill({ status: 404 });
      } else {
        await route.continue();
      }
    }),
  ]);
}

test('textarea and save button visible on share page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('text-input')).toBeVisible();
  await expect(page.getByTestId('text-save')).toBeVisible();
  await expect(page.getByTestId('text-save')).toBeDisabled();
});

test('type text and save navigates to viewer with content', async ({ page }) => {
  const text = 'Hello from the pastebin!';
  const expectedHash = createHash('sha256').update(text).digest('hex');

  await mockBlossom(page, expectedHash, text);
  await page.goto('/');

  await page.getByTestId('text-input').fill(text);
  await page.getByTestId('text-save').click();

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });
  expect(page.url()).toContain('nhash1');
  expect(page.url()).toContain('/text.txt');
  await expect(page.getByTestId('viewer-text')).toContainText(text);
});

test('cmd/ctrl+enter saves pasted text', async ({ page }) => {
  const text = 'Shortcut save from textarea';
  const expectedHash = createHash('sha256').update(text).digest('hex');

  await mockBlossom(page, expectedHash, text);
  await page.goto('/');

  await page.getByTestId('text-input').fill(text);
  await page.getByTestId('text-input').press(SAVE_WITH_ENTER);

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('viewer-text')).toContainText(text);
});

test('edit button visible for text files in viewer', async ({ page }) => {
  const fileContent = 'editable text';
  const expectedHash = createHash('sha256').update(fileContent).digest('hex');

  await mockBlossom(page, expectedHash, fileContent);
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles({
    name: 'doc.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(fileContent),
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('edit-button')).toBeVisible();
});

test('edit text file and save creates new nhash URL', async ({ page }) => {
  const originalText = 'original content';
  const editedText = 'edited content';
  const originalHash = createHash('sha256').update(originalText).digest('hex');
  const editedHash = createHash('sha256').update(editedText).digest('hex');

  // Mock both hashes
  await mockBlossom(page, originalHash, originalText);
  await mockBlossom(page, editedHash, editedText);
  await page.goto('/');

  // Upload original file
  await page.getByTestId('file-input').setInputFiles({
    name: 'doc.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(originalText),
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });
  const originalUrl = page.url();

  // Enter edit mode
  await page.getByTestId('edit-button').click();
  await expect(page.getByTestId('edit-textarea')).toBeVisible();

  // Edit and save
  await page.getByTestId('edit-textarea').fill(editedText);
  await page.getByTestId('edit-save').click();

  // Should navigate to new URL
  await expect(page.getByTestId('viewer-text')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('viewer-text')).toContainText(editedText);
  expect(page.url()).not.toBe(originalUrl);
  expect(page.url()).toContain('nhash1');
});

test('cmd/ctrl+enter saves edited text', async ({ page }) => {
  const originalText = 'original content from shortcut test';
  const editedText = 'edited with keyboard shortcut';
  const originalHash = createHash('sha256').update(originalText).digest('hex');
  const editedHash = createHash('sha256').update(editedText).digest('hex');

  await mockBlossom(page, originalHash, originalText);
  await mockBlossom(page, editedHash, editedText);
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles({
    name: 'doc.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(originalText),
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });

  await page.getByTestId('edit-button').click();
  await expect(page.getByTestId('edit-textarea')).toBeVisible();

  await page.getByTestId('edit-textarea').fill(editedText);
  await page.getByTestId('edit-textarea').press(SAVE_WITH_ENTER);

  await expect(page.getByTestId('viewer-text')).toContainText(editedText, { timeout: 10000 });
});

test('browser back after edit returns to previous nhash URL', async ({ page }) => {
  const originalText = 'before edit';
  const editedText = 'after edit';
  const originalHash = createHash('sha256').update(originalText).digest('hex');
  const editedHash = createHash('sha256').update(editedText).digest('hex');

  await mockBlossom(page, originalHash, originalText);
  await mockBlossom(page, editedHash, editedText);
  await page.goto('/');

  // Upload original
  await page.getByTestId('file-input').setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(originalText),
  });

  await expect(page.getByTestId('file-viewer')).toBeVisible({ timeout: 10000 });
  const originalUrl = page.url();

  // Edit and save
  await page.getByTestId('edit-button').click();
  await page.getByTestId('edit-textarea').fill(editedText);
  await page.getByTestId('edit-save').click();

  await expect(page.getByTestId('viewer-text')).toContainText(editedText, { timeout: 10000 });

  // Go back
  await page.goBack();
  await expect(page.getByTestId('viewer-text')).toContainText(originalText, { timeout: 10000 });
  expect(page.url()).toBe(originalUrl);
});
