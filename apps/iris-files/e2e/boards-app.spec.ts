import { test, expect } from './fixtures';
import { waitForAppReady, ensureLoggedIn, disableOthersPool, enableOthersPool, setupPageErrorHandler, flushPendingPublishes, waitForRelayConnected } from './test-utils';
import type { Page } from '@playwright/test';
import { nip19 } from 'nostr-tools';

type BoardsE2EWindow = Window & {
  __nostrStore?: {
    getState?: () => {
      pubkey?: string | null;
    };
  };
  __boardLiveMarker?: string;
  __boardPermissionMarker?: string;
};

async function createBoard(
  page: Page,
  boardName: string,
  visibility: 'public' | 'link-visible' | 'private' = 'public'
): Promise<string> {
  let workerCrashed = false;
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('[WorkerAdapter] Worker crashed')) {
      workerCrashed = true;
    }
  });

  let created = false;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    await page.getByRole('button', { name: /new board/i }).click();
    await expect(page.getByRole('heading', { name: 'Create Board' })).toBeVisible({ timeout: 15000 });
    const input = page.getByPlaceholder('Board name');
    const createButton = page.getByRole('button', { name: /^create$/i });
    try {
      await input.fill(boardName, { timeout: 5000 });
      if (visibility !== 'public') {
        await page.getByRole('button', { name: new RegExp(`^${visibility}$`, 'i') }).click();
      }
      await createButton.click();
      created = true;
    } catch {
      await page.waitForTimeout(1000);
    }
  }

  expect(created).toBe(true);
  expect(workerCrashed).toBe(false);
  await page.waitForURL(new RegExp(`/boards\\.html#\\/npub.*\\/boards%2F${encodeURIComponent(boardName)}`), { timeout: 30000 });
  await expect(page.locator(`text=${boardName}`)).toBeVisible({ timeout: 30000 });
  await expect(page.locator('text=Failed to create board.')).toHaveCount(0);
  return page.url();
}

test.describe('Iris Boards App', () => {
  test('can create a new board', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);
    await ensureLoggedIn(page, 30000);
    await waitForRelayConnected(page, 30000);

    let workerCrashed = false;
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('[WorkerAdapter] Worker crashed')) {
        workerCrashed = true;
      }
    });

    const boardName = `E2E Board ${Date.now()}`;
    let created = false;
    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
      await page.getByRole('button', { name: /new board/i }).click();
      await expect(page.getByRole('heading', { name: 'Create Board' })).toBeVisible({ timeout: 15000 });
      const input = page.getByPlaceholder('Board name');
      const createButton = page.getByRole('button', { name: /^create$/i });
      try {
        await input.fill(boardName, { timeout: 5000 });
        await createButton.click();
        created = true;
      } catch {
        await page.waitForTimeout(1000);
      }
    }
    expect(created).toBe(true);

    await page.waitForURL(/\/boards\.html#\/npub.*\/boards%2FE2E%20Board/, { timeout: 30000 });
    await expect(page.locator(`text=${boardName}`)).toBeVisible({ timeout: 30000 });
    await expect(page.locator('text=Failed to create board.')).toHaveCount(0);
    expect(workerCrashed).toBe(false);
  });

  test('trello-like cards use modal editing and can be dragged between columns', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);
    await ensureLoggedIn(page, 30000);

    const boardName = `E2E Draggable ${Date.now()}`;
    await createBoard(page, boardName);

    const todoColumn = page.getByTestId('board-column-Todo');
    await expect(todoColumn).toBeVisible({ timeout: 15000 });

    await todoColumn.getByRole('button', { name: /add card/i }).click();
    await expect(page.getByRole('heading', { name: 'Create Card' })).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Create Card' })).toHaveCount(0);
    await todoColumn.getByRole('button', { name: /add card/i }).click();
    await expect(page.getByRole('heading', { name: 'Create Card' })).toBeVisible({ timeout: 10000 });
    await page.getByLabel('Card title').fill('Ship drag and drop');
    await page.getByLabel('Card description').fill('Implement Trello-like movement.');
    const createModalChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^attach files$/i }).click();
    const createModalChooser = await createModalChooserPromise;
    await createModalChooser.setFiles([
      {
        name: 'create-modal.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('added while creating card', 'utf-8'),
      },
    ]);
    await expect(page.getByText('create-modal.txt')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /^create card$/i }).click();
    await expect(page.getByRole('heading', { name: 'Create Card' })).toHaveCount(0);

    const createdCard = page.getByTestId('board-card-Ship drag and drop');
    await expect(createdCard).toBeVisible({ timeout: 10000 });
    await expect(createdCard.getByText('create-modal.txt')).toBeVisible({ timeout: 10000 });
    await expect(createdCard.locator('input, textarea')).toHaveCount(0);
    await expect(createdCard.getByRole('button', { name: /attach file/i })).toHaveCount(0);
    await expect(createdCard.getByRole('button', { name: /remove card/i })).toHaveCount(0);
    await expect(createdCard.getByRole('button', { name: /quick edit card/i })).toHaveCount(1);

    await createdCard.getByRole('button', { name: /open card details/i }).click();
    const cardDetailsDialog = page.getByRole('dialog', { name: 'Card details' });
    await expect(cardDetailsDialog).toBeVisible({ timeout: 10000 });
    await cardDetailsDialog.getByRole('button', { name: /edit card/i }).click();
    await expect(page.getByRole('heading', { name: 'Edit Card' })).toBeVisible({ timeout: 10000 });
    const editModalChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^attach files$/i }).click();
    const editModalChooser = await editModalChooserPromise;
    await editModalChooser.setFiles([
      {
        name: 'edit-modal.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('added while editing card', 'utf-8'),
      },
    ]);
    await expect(page.getByText('edit-modal.txt')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /^save card$/i }).click();
    await expect(page.getByRole('heading', { name: 'Edit Card' })).toHaveCount(0);
    await expect(createdCard.getByText('edit-modal.txt')).toBeVisible({ timeout: 10000 });

    await createdCard.getByRole('button', { name: /open card details/i }).click();
    await expect(cardDetailsDialog).toBeVisible({ timeout: 10000 });

    const chooserPromise = page.waitForEvent('filechooser');
    await cardDetailsDialog.getByRole('button', { name: /^attach file$/i }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles([
      {
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('attachment body', 'utf-8'),
      },
      {
        name: 'tiny.png',
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8G7x0AAAAASUVORK5CYII=', 'base64'),
      },
    ]);
    await expect(cardDetailsDialog.getByText('notes.txt')).toBeVisible({ timeout: 10000 });
    const cardDetailsImage = cardDetailsDialog.getByRole('img', { name: 'tiny.png' });
    await expect(cardDetailsImage).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => {
      return cardDetailsImage.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
    }, { timeout: 20000 }).toBe(true);
    const imageSrc = await cardDetailsImage.getAttribute('src');
    expect(!!imageSrc && (imageSrc.startsWith('blob:') || imageSrc.includes('/htree/nhash1'))).toBe(true);
    await expect(cardDetailsDialog.getByText(/^Uploaded$/)).toHaveCount(0);

    const popupOpenedPromise = page
      .waitForEvent('popup', { timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    await cardDetailsImage.click();
    const mediaDialog = page.getByRole('dialog', { name: 'Attachment preview' });
    await expect(mediaDialog).toBeVisible({ timeout: 10000 });
    await expect(mediaDialog.getByRole('link', { name: /^open file$/i })).toHaveAttribute('href', /\/htree\/nhash1/);
    expect(await popupOpenedPromise).toBe(false);
    await page.keyboard.press('Escape');
    await expect(mediaDialog).toHaveCount(0);

    const cardAttachmentImage = createdCard.getByRole('img', { name: 'tiny.png' });
    await expect(cardAttachmentImage).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => {
      return cardAttachmentImage.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
    }, { timeout: 20000 }).toBe(true);

    if (await cardDetailsDialog.count() === 0) {
      await createdCard.getByRole('button', { name: /open card details/i }).click();
      await expect(cardDetailsDialog).toBeVisible({ timeout: 10000 });
    }

    await page.getByTestId('board-comment-attachment-input').setInputFiles([
      {
        name: 'comment-image.png',
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8G7x0AAAAASUVORK5CYII=', 'base64'),
      },
    ]);
    await page.getByPlaceholder('Add comment.').fill('**Looks good**');
    await cardDetailsDialog.getByRole('button', { name: /add comment/i }).click();
    await expect(cardDetailsDialog.getByText('Looks good')).toBeVisible({ timeout: 10000 });
    await expect(cardDetailsDialog.getByRole('img', { name: 'comment-image.png' })).toBeVisible({ timeout: 10000 });

    if (await cardDetailsDialog.count() === 0) {
      await createdCard.getByRole('button', { name: /open card details/i }).click();
      await expect(cardDetailsDialog).toBeVisible({ timeout: 10000 });
    }

    await cardDetailsDialog.getByRole('button', { name: /edit card/i }).click();
    await expect(page.getByRole('heading', { name: 'Edit Card' })).toBeVisible({ timeout: 10000 });
    await page.getByLabel('Card title').fill('Ship card drag');
    await page.getByRole('button', { name: /^save card$/i }).click();
    await expect(page.getByTestId('board-card-Ship card drag')).toBeVisible({ timeout: 10000 });

    const doingDropzone = page.getByTestId('board-column-cards-Doing');
    await page.getByTestId('board-card-Ship card drag').dragTo(doingDropzone);
    await expect(page.getByTestId('board-column-Doing').getByTestId('board-card-Ship card drag')).toBeVisible({ timeout: 10000 });
  });

  test('link-visible board syncs to another browser in realtime without reload', async ({ page, browser }) => {
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await ensureLoggedIn(page, 30000);
    await enableOthersPool(page, 10);
    await waitForRelayConnected(page, 30000);

    const boardName = `E2E Live Sync ${Date.now()}`;
    const shareUrl = await createBoard(page, boardName, 'link-visible');
    expect(shareUrl).toMatch(/\?k=/);

    const page1Todo = page.getByTestId('board-column-Todo');
    await expect(page1Todo).toBeVisible({ timeout: 15000 });
    await flushPendingPublishes(page);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    setupPageErrorHandler(page2);

    await page2.goto(shareUrl);
    await waitForAppReady(page2, 60000);
    await ensureLoggedIn(page2, 30000);
    await enableOthersPool(page2, 10);
    await waitForRelayConnected(page2, 30000);

    const page1Pubkey = await page.evaluate(() => (window as BoardsE2EWindow).__nostrStore?.getState?.().pubkey ?? null);
    const initialPage2Pubkey = await page2.evaluate(() => (window as BoardsE2EWindow).__nostrStore?.getState?.().pubkey ?? null);
    if (page1Pubkey && initialPage2Pubkey === page1Pubkey) {
      await page2.evaluate(async () => {
        const { generateNewKey } = await import('/src/nostr');
        await generateNewKey();
      });
      await page2.waitForFunction((ownerPubkey) => {
        const pubkey = (window as BoardsE2EWindow).__nostrStore?.getState?.().pubkey;
        return !!pubkey && pubkey !== ownerPubkey;
      }, page1Pubkey, { timeout: 20000 });
      await waitForRelayConnected(page2, 30000);
      await page2.goto(shareUrl);
      await waitForAppReady(page2, 60000);
      await enableOthersPool(page2, 10);
      await waitForRelayConnected(page2, 30000);
    }

    await expect(page2.getByRole('heading', { name: boardName })).toBeVisible({ timeout: 30000 });
    await expect(page2.locator('text=Read-only')).toBeVisible({ timeout: 30000 });
    await expect(page2.getByTestId('board-column-Todo')).toBeVisible({ timeout: 45000 });
    await expect(page2.getByRole('button', { name: /permissions/i })).toBeVisible({ timeout: 15000 });

    await page2.getByRole('button', { name: /permissions/i }).click();
    await expect(page2.getByRole('heading', { name: 'Board Permissions' })).toBeVisible({ timeout: 10000 });
    await expect(page2.getByText(/share your npub with an admin to request write access/i)).toBeVisible({ timeout: 10000 });
    await expect(page2.getByPlaceholder('npub1...')).toHaveCount(0);
    await expect(page2.getByRole('button', { name: /^add$/i })).toHaveCount(0);
    await page2.getByRole('button', { name: /close permissions dialog/i }).click();
    await expect(page2.getByRole('heading', { name: 'Board Permissions' })).toHaveCount(0);

    const liveMarker = await page2.evaluate(() => {
      const marker = `board-live-${Math.random().toString(36).slice(2)}`;
      (window as BoardsE2EWindow).__boardLiveMarker = marker;
      return marker;
    });

    await page1Todo.getByRole('button', { name: /add card/i }).click();
    await expect(page.getByRole('heading', { name: 'Create Card' })).toBeVisible({ timeout: 10000 });
    await page.getByLabel('Card title').fill('Realtime card');
    await page.getByLabel('Card description').fill('Should appear in browser 2 without reload.');
    await page.getByRole('button', { name: /^create card$/i }).click();
    await expect(page.getByTestId('board-card-Realtime card')).toBeVisible({ timeout: 10000 });
    await flushPendingPublishes(page);

    await expect(page2.getByRole('heading', { name: /^Realtime card$/ })).toBeVisible({ timeout: 45000 });

    await page.getByTestId('board-card-Realtime card').getByRole('button', { name: /open card details/i }).click();
    await page.getByRole('dialog', { name: 'Card details' }).getByRole('button', { name: /edit card/i }).click();
    await expect(page.getByRole('heading', { name: 'Edit Card' })).toBeVisible({ timeout: 10000 });
    await page.getByLabel('Card title').fill('Realtime card updated');
    await page.getByRole('button', { name: /^save card$/i }).click();
    await flushPendingPublishes(page);

    await expect(page2.getByRole('heading', { name: /^Realtime card updated$/ })).toBeVisible({ timeout: 45000 });
    await expect(page2.getByRole('heading', { name: /^Realtime card$/ })).toHaveCount(0, { timeout: 45000 });

    await expect.poll(async () => {
      return page2.evaluate(() => (window as BoardsE2EWindow).__boardLiveMarker);
    }, { timeout: 15000 }).toBe(liveMarker);

    await context2.close();
  });

  test('granting writer permission updates viewer live and enables editing', async ({ page, browser }) => {
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await ensureLoggedIn(page, 30000);
    await enableOthersPool(page, 10);
    await waitForRelayConnected(page, 30000);

    const boardName = `E2E Permission Sync ${Date.now()}`;
    const shareUrl = await createBoard(page, boardName, 'link-visible');
    expect(shareUrl).toMatch(/\?k=/);
    await flushPendingPublishes(page);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    setupPageErrorHandler(page2);

    await page2.goto(shareUrl);
    await waitForAppReady(page2, 60000);
    await ensureLoggedIn(page2, 30000);
    await enableOthersPool(page2, 10);
    await waitForRelayConnected(page2, 30000);

    const page1Pubkey = await page.evaluate(() => (window as BoardsE2EWindow).__nostrStore?.getState?.().pubkey ?? null);
    const initialPage2Pubkey = await page2.evaluate(() => (window as BoardsE2EWindow).__nostrStore?.getState?.().pubkey ?? null);
    if (page1Pubkey && initialPage2Pubkey === page1Pubkey) {
      await page2.evaluate(async () => {
        const { generateNewKey } = await import('/src/nostr');
        await generateNewKey();
      });
      await page2.waitForFunction((ownerPubkey) => {
        const pubkey = (window as BoardsE2EWindow).__nostrStore?.getState?.().pubkey;
        return !!pubkey && pubkey !== ownerPubkey;
      }, page1Pubkey, { timeout: 20000 });
      await waitForRelayConnected(page2, 30000);
      await page2.goto(shareUrl);
      await waitForAppReady(page2, 60000);
      await enableOthersPool(page2, 10);
      await waitForRelayConnected(page2, 30000);
    }

    const page2Pubkey = await page2.evaluate(() => (window as BoardsE2EWindow).__nostrStore?.getState?.().pubkey ?? null);
    expect(typeof page2Pubkey).toBe('string');
    expect((page2Pubkey as string).length).toBe(64);
    const page2Npub = nip19.npubEncode(page2Pubkey as string);

    const page2Todo = page2.getByTestId('board-column-Todo');
    await expect(page2Todo).toBeVisible({ timeout: 45000 });
    await expect(page2.locator('text=Read-only')).toBeVisible({ timeout: 45000 });
    await expect(page2Todo.getByRole('button', { name: /add card/i })).toHaveCount(0);

    const liveMarker = await page2.evaluate(() => {
      const marker = `board-perm-live-${Math.random().toString(36).slice(2)}`;
      (window as BoardsE2EWindow).__boardPermissionMarker = marker;
      return marker;
    });

    await page.getByRole('button', { name: /permissions/i }).click();
    await expect(page.getByRole('heading', { name: 'Board Permissions' })).toBeVisible({ timeout: 10000 });
    await page.getByPlaceholder('npub1...').fill(page2Npub);
    await page.getByRole('combobox').selectOption('writer');
    await page.getByRole('button', { name: /^add$/i }).click();
    await flushPendingPublishes(page);

    await expect(page2.locator('text=Write access')).toBeVisible({ timeout: 45000 });
    await expect(page2.locator('text=Read-only')).toHaveCount(0, { timeout: 45000 });
    await expect(page2Todo.getByRole('button', { name: /add card/i })).toBeVisible({ timeout: 45000 });

    await expect.poll(async () => {
      return page2.evaluate(() => (window as BoardsE2EWindow).__boardPermissionMarker);
    }, { timeout: 15000 }).toBe(liveMarker);

    await page2Todo.getByRole('button', { name: /add card/i }).click();
    await expect(page2.getByRole('heading', { name: 'Create Card' })).toBeVisible({ timeout: 10000 });
    await page2.getByLabel('Card title').fill('Granted writer card');
    await page2.getByLabel('Card description').fill('Created by user 2 after live permission grant.');
    await page2.getByRole('button', { name: /^create card$/i }).click();
    await expect(page2.getByTestId('board-card-Granted writer card')).toBeVisible({ timeout: 10000 });
    await page2.getByTestId('board-card-Granted writer card').getByRole('button', { name: /open card details/i }).click();
    await page2.getByRole('dialog', { name: 'Card details' }).getByRole('button', { name: /edit card/i }).click();
    await expect(page2.getByRole('heading', { name: 'Edit Card' })).toBeVisible({ timeout: 10000 });
    await page2.getByLabel('Card title').fill('Granted writer card updated');
    await page2.getByRole('button', { name: /^save card$/i }).click();
    await expect(page2.getByTestId('board-card-Granted writer card updated')).toBeVisible({ timeout: 10000 });

    await context2.close();
  });
});
