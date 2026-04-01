import { test, expect } from './fixtures';
import { waitForAppReady, ensureLoggedIn, disableOthersPool, enableOthersPool, setupPageErrorHandler, flushPendingPublishes, waitForRelayConnected, useLocalRelay, configureBlossomServers } from './test-utils';
import type { Locator, Page } from '@playwright/test';
import { nip19 } from 'nostr-tools';

// Run boards tests serially because they share relay-backed board state and realtime sync timing.
test.describe.configure({ mode: 'serial' });

type BoardsE2EWindow = Window & {
  __nostrStore?: {
    getState?: () => {
      pubkey?: string | null;
    };
  };
  __getWorkerAdapter?: () => TreeRootCacheAdapter | null | undefined;
  __workerAdapter?: TreeRootCacheAdapter;
  __boardLiveMarker?: string;
  __boardPermissionMarker?: string;
};

type TreeRootCacheAdapter = {
  setTreeRootCache?: (
    npub: string,
    treeName: string,
    hash: Uint8Array,
    key?: Uint8Array,
    visibility?: 'public' | 'link-visible' | 'private'
  ) => Promise<void>;
};

async function readNostrPubkey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = (window as BoardsE2EWindow).__nostrStore?.getState?.().pubkey ?? null;
    if (typeof raw === 'string') return raw;
    if (!raw || typeof raw !== 'object') return null;

    const candidate = raw as {
      pubkey?: unknown;
      hex?: unknown;
      value?: unknown;
      toHex?: () => string;
      toString?: () => string;
    };

    if (typeof candidate.pubkey === 'string') return candidate.pubkey;
    if (typeof candidate.hex === 'string') return candidate.hex;
    if (typeof candidate.value === 'string') return candidate.value;
    if (typeof candidate.toHex === 'function') return candidate.toHex();
    if (typeof candidate.toString === 'function') {
      const value = candidate.toString();
      if (value && value !== '[object Object]') return value;
    }
    return null;
  });
}

async function getCurrentRootSignature(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    const root = getCurrentRootCid();
    if (!root) return null;
    const hash = Array.from(root.hash).join(',');
    const key = root.key ? Array.from(root.key).join(',') : '';
    return `${hash}:${key}`;
  });
}

async function getTreeRootSignature(
  page: Page,
  npub: string,
  treeName: string
): Promise<string | null> {
  return page.evaluate(async ({ targetNpub, targetTree }) => {
    const { getTreeRootSync } = await import('/src/stores/index.ts');
    const root = getTreeRootSync(targetNpub, targetTree);
    if (!root) return null;
    const hash = Array.from(root.hash).join(',');
    const key = root.key ? Array.from(root.key).join(',') : '';
    return `${hash}:${key}`;
  }, { targetNpub: npub, targetTree: treeName });
}

async function flushBoardRootUpdate(
  page: Page,
  previousSignature: string | null,
  timeoutMs: number = 20000
): Promise<void> {
  await page.waitForFunction(async (previous) => {
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    const root = getCurrentRootCid();
    if (!root) return false;
    const hash = Array.from(root.hash).join(',');
    const key = root.key ? Array.from(root.key).join(',') : '';
    return `${hash}:${key}` !== previous;
  }, previousSignature, { timeout: timeoutMs });
  await flushPendingPublishes(page);
}

async function flushTreeRootUpdate(
  page: Page,
  npub: string,
  treeName: string,
  previousSignature: string | null,
  timeoutMs: number = 20000
): Promise<void> {
  await page.waitForFunction(async ({ targetNpub, targetTree, previous }) => {
    const { getTreeRootSync } = await import('/src/stores/index.ts');
    const root = getTreeRootSync(targetNpub, targetTree);
    if (!root) return false;
    const hash = Array.from(root.hash).join(',');
    const key = root.key ? Array.from(root.key).join(',') : '';
    return `${hash}:${key}` !== previous;
  }, { targetNpub: npub, targetTree: treeName, previous: previousSignature }, { timeout: timeoutMs });
  await flushPendingPublishes(page);
}

async function waitForTreePublished(page: Page, npub: string, treeName: string, timeoutMs: number = 30000): Promise<void> {
  await waitForRelayConnected(page, Math.min(timeoutMs, 15000));
  await flushPendingPublishes(page);
  await page.waitForFunction(
    ({ owner, tree }) => {
      const raw = localStorage.getItem('hashtree:localRootCache');
      if (!raw) return false;
      try {
        const data = JSON.parse(raw);
        const entry = data?.[`${owner}/${tree}`];
        return entry && entry.dirty === false;
      } catch {
        return false;
      }
    },
    { owner: npub, tree: treeName },
    { timeout: timeoutMs }
  );
}

async function waitForTreeRoot(page: Page, npub: string, treeName: string, timeoutMs: number = 60000): Promise<void> {
  await page.evaluate(async ({ targetNpub, targetTree, timeout }) => {
    const { waitForTreeRoot } = await import('/src/stores/index.ts');
    await waitForTreeRoot(targetNpub, targetTree, timeout);
  }, { targetNpub: npub, targetTree: treeName, timeout: timeoutMs });
}

async function waitForTreeRootHash(
  page: Page,
  npub: string,
  treeName: string,
  expectedHash: string,
  timeoutMs: number = 60000
): Promise<void> {
  await page.waitForFunction(
    async ({ targetNpub, targetTree, targetHash }) => {
      const { getTreeRootSync } = await import('/src/stores/index.ts');
      const toHex = (bytes: Uint8Array): string => Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const root = getTreeRootSync(targetNpub, targetTree);
      if (!root) return false;
      return toHex(root.hash) === targetHash;
    },
    { targetNpub: npub, targetTree: treeName, targetHash: expectedHash },
    { timeout: timeoutMs }
  );
}

async function waitForTreeRootStoreHash(
  page: Page,
  expectedHash: string,
  timeoutMs: number = 60000
): Promise<void> {
  await page.waitForFunction(
    async (targetHash: string) => {
      const { treeRootStore } = await import('/src/stores/index.ts');
      const toHex = (bytes: Uint8Array): string => Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      let root: { hash?: Uint8Array } | null = null;
      const unsub = treeRootStore.subscribe((value) => { root = value as { hash?: Uint8Array } | null; });
      unsub();
      if (!root?.hash) return false;
      return toHex(root.hash) === targetHash;
    },
    expectedHash,
    { timeout: timeoutMs }
  );
}

async function getTreeRootHex(page: Page, npub: string, treeName: string): Promise<{ hashHex: string; keyHex: string | null }> {
  const root = await page.evaluate(async ({ targetNpub, targetTree }) => {
    const { getTreeRootSync } = await import('/src/stores/index.ts');
    const toHex = (bytes: Uint8Array): string => Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const rootCid = getTreeRootSync(targetNpub, targetTree);
    if (!rootCid?.hash) return null;
    return {
      hashHex: toHex(rootCid.hash),
      keyHex: rootCid.key ? toHex(rootCid.key) : null,
    };
  }, { targetNpub: npub, targetTree: treeName });

  if (!root) {
    throw new Error(`Could not read tree root for ${npub}/${treeName}`);
  }
  return root;
}

async function primeTreeRootInViewer(
  page: Page,
  npub: string,
  treeName: string,
  root: { hashHex: string; keyHex: string | null }
): Promise<void> {
  await page.evaluate(async ({ targetNpub, targetTree, hashHex, keyHex }) => {
    const { updateLocalRootCacheHex } = await import('/src/treeRootCache.ts');
    const { treeRootRegistry } = await import('/src/TreeRootRegistry.ts');
    const fromHex = (hex: string): Uint8Array => {
      const normalized = hex.trim().toLowerCase();
      if (!normalized || normalized.length % 2 !== 0) return new Uint8Array();
      const out = new Uint8Array(normalized.length / 2);
      for (let i = 0; i < out.length; i += 1) {
        const byte = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(byte)) return new Uint8Array();
        out[i] = byte;
      }
      return out;
    };

    updateLocalRootCacheHex(targetNpub, targetTree, hashHex, keyHex ?? undefined, 'link-visible');
    treeRootRegistry.setFromExternal(targetNpub, targetTree, fromHex(hashHex), 'prefetch', {
      key: keyHex ? fromHex(keyHex) : undefined,
      visibility: 'link-visible',
      updatedAt: Math.floor(Date.now() / 1000),
    });

    const adapter = (window as BoardsE2EWindow).__getWorkerAdapter?.() ?? (window as BoardsE2EWindow).__workerAdapter;
    if (adapter?.setTreeRootCache) {
      await adapter.setTreeRootCache(
        targetNpub,
        targetTree,
        fromHex(hashHex),
        keyHex ? fromHex(keyHex) : undefined,
        'link-visible'
      );
    }
  }, { targetNpub: npub, targetTree: treeName, hashHex: root.hashHex, keyHex: root.keyHex });
}

async function ensureViewerTreeRoot(
  page: Page,
  npub: string,
  treeName: string,
  root: { hashHex: string; keyHex: string | null },
  timeoutMs: number = 60000
): Promise<void> {
  await waitForTreeRoot(page, npub, treeName, Math.min(timeoutMs, 30000)).catch(() => {});
  await primeTreeRootInViewer(page, npub, treeName, root);
  await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
  await waitForTreeRootHash(page, npub, treeName, root.hashHex, timeoutMs);
  await waitForTreeRootStoreHash(page, root.hashHex, Math.min(timeoutMs, 30000));
}

async function gotoWithRetry(page: Page, url: string, attempts: number = 3): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await page.goto(url);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('ERR_CONNECTION_REFUSED') || attempt === attempts - 1) {
        throw error;
      }
      await page.waitForTimeout(1000 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to navigate to ${url}`);
}

function parseBoardShareUrl(shareUrl: string): { npub: string; treeName: string; linkKey: string | null } {
  const match = shareUrl.match(/#\/(npub[^/]+)\/([^?]+)(?:\?(.+))?$/);
  if (!match) {
    throw new Error(`Could not parse board share URL: ${shareUrl}`);
  }

  const params = new URLSearchParams(match[3] ?? '');
  return {
    npub: match[1],
    treeName: decodeURIComponent(match[2]),
    linkKey: params.get('k'),
  };
}

async function setupFreshBoardsViewer(ownerPage: Page, viewerPage: Page, shareUrl?: string): Promise<void> {
  setupPageErrorHandler(viewerPage);
  await gotoWithRetry(viewerPage, '/boards.html#/');
  await waitForAppReady(viewerPage, 60000);
  await useLocalRelay(viewerPage);
  await configureBlossomServers(viewerPage);
  await ensureLoggedIn(viewerPage, 30000);
  await enableOthersPool(viewerPage, 10);
  await waitForRelayConnected(viewerPage, 30000);
  await ensureDistinctViewerIdentity(ownerPage, viewerPage);

  if (shareUrl) {
    await gotoWithRetry(viewerPage, shareUrl);
    await waitForAppReady(viewerPage, 60000);
    await useLocalRelay(viewerPage);
    await configureBlossomServers(viewerPage);
    await ensureLoggedIn(viewerPage, 30000);
    await enableOthersPool(viewerPage, 10);
    await waitForRelayConnected(viewerPage, 30000);
    await ensureDistinctViewerIdentity(ownerPage, viewerPage);
  }
}

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
    await openCreateBoardModal(page);
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

async function ensureDistinctViewerIdentity(ownerPage: Page, viewerPage: Page): Promise<void> {
  const ownerPubkey = await readNostrPubkey(ownerPage);
  const initialViewerPubkey = await readNostrPubkey(viewerPage);
  if (!ownerPubkey || initialViewerPubkey !== ownerPubkey) return;

  await viewerPage.evaluate(async () => {
    const { generateNewKey } = await import('/src/nostr.ts');
    await generateNewKey();
  });
  await viewerPage.waitForFunction((expectedOwnerPubkey) => {
    const raw = (window as BoardsE2EWindow).__nostrStore?.getState?.().pubkey ?? null;
    const normalize = (value: unknown): string | null => {
      if (typeof value === 'string') return value;
      if (!value || typeof value !== 'object') return null;
      const candidate = value as {
        pubkey?: unknown;
        hex?: unknown;
        value?: unknown;
        toHex?: () => string;
        toString?: () => string;
      };
      if (typeof candidate.pubkey === 'string') return candidate.pubkey;
      if (typeof candidate.hex === 'string') return candidate.hex;
      if (typeof candidate.value === 'string') return candidate.value;
      if (typeof candidate.toHex === 'function') return candidate.toHex();
      if (typeof candidate.toString === 'function') {
        const text = candidate.toString();
        if (text && text !== '[object Object]') return text;
      }
      return null;
    };
    const pubkey = normalize(raw);
    return !!pubkey && pubkey !== expectedOwnerPubkey;
  }, ownerPubkey, { timeout: 20000 });
  await waitForRelayConnected(viewerPage, 30000);
}

async function openCreateBoardModal(page: Page, attempts: number = 3): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Create Board' });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.getByRole('button', { name: /new board/i }).click();
    try {
      await expect(heading).toBeVisible({ timeout: 5000 });
      return;
    } catch (error) {
      if (attempt === attempts - 1) {
        throw error;
      }
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500 * (attempt + 1));
    }
  }
}

async function addBoardPermissionEntry(
  dialog: Locator,
  npub: string,
  role: 'admin' | 'writer'
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const roleSelect = dialog.getByRole('combobox');
    if (await roleSelect.count()) {
      await roleSelect.first().selectOption(role);
    }

    await dialog.getByPlaceholder('npub1...').fill(npub);

    const confirmButton = dialog.getByRole('button', { name: new RegExp(`^add ${role}$`, 'i') });
    const addButton = (await confirmButton.isVisible().catch(() => false))
      ? confirmButton
      : dialog.getByRole('button', { name: /^add$/i });

    try {
      await addButton.click({ timeout: 5000 });
      return;
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
      await expect(dialog).toBeVisible({ timeout: 5000 });
    }
  }
}

async function waitForBoardPermissionEntry(
  page: Page,
  npub: string,
  timeoutMs: number = 60000
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Board Permissions' });
  const openButton = page.getByRole('button', { name: /permissions/i });
  const closeButton = dialog.getByRole('button', { name: /^close$/i }).last();
  const memberLink = dialog.locator(`a[href="#/${npub}/profile"]`);

  if (!(await dialog.isVisible().catch(() => false))) {
    await openButton.click();
  }

  await expect(dialog).toBeVisible({ timeout: 10000 });
  await expect(memberLink).toBeVisible({ timeout: timeoutMs });
  await closeButton.click();
  await expect(dialog).toHaveCount(0, { timeout: 10000 });
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
      await openCreateBoardModal(page);
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

  test('create and edit column modals autofocus the column title input', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);
    await ensureLoggedIn(page, 30000);
    await waitForRelayConnected(page, 30000);

    const boardName = `E2E Column Focus ${Date.now()}`;
    await createBoard(page, boardName);

    await page.getByRole('button', { name: /^add column$/i }).click();
    await expect(page.getByRole('heading', { name: 'Create Column' })).toBeVisible({ timeout: 10000 });
    const createInput = page.getByLabel('Column title');
    await expect(createInput).toBeFocused();
    await createInput.fill('Inbox');
    await page.getByRole('button', { name: /^create column$/i }).click();
    await expect(page.getByRole('heading', { name: 'Create Column' })).toHaveCount(0);

    const todoColumn = page.getByTestId('board-column-Todo');
    await expect(todoColumn).toBeVisible({ timeout: 10000 });
    await todoColumn.hover();
    await todoColumn.getByRole('button', { name: /edit column/i }).click();
    await expect(page.getByRole('heading', { name: 'Edit Column' })).toBeVisible({ timeout: 10000 });

    const editInput = page.getByLabel('Column title');
    await expect(editInput).toBeFocused();
    await expect(editInput).toHaveValue('Todo');
  });

  test('boards dialogs close on Escape', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);
    await ensureLoggedIn(page, 30000);
    await waitForRelayConnected(page, 30000);

    await openCreateBoardModal(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Create Board' })).toHaveCount(0);

    const boardName = `E2E Escape Close ${Date.now()}`;
    await createBoard(page, boardName);

    await page.getByRole('button', { name: /^add column$/i }).click();
    await expect(page.getByRole('heading', { name: 'Create Column' })).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Create Column' })).toHaveCount(0);

    const todoColumn = page.getByTestId('board-column-Todo');
    await expect(todoColumn).toBeVisible({ timeout: 10000 });
    await todoColumn.hover();
    await todoColumn.getByRole('button', { name: /edit column/i }).click();
    await expect(page.getByRole('heading', { name: 'Edit Column' })).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Edit Column' })).toHaveCount(0);

    await page.getByRole('button', { name: /permissions/i }).click();
    await expect(page.getByRole('heading', { name: 'Board Permissions' })).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Board Permissions' })).toHaveCount(0);
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
    const cardDetailsImageButton = cardDetailsDialog.locator('button[title="tiny.png"]').first();
    await expect(cardDetailsImageButton).toBeVisible({ timeout: 10000 });
    await cardDetailsImageButton.click();
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
    await expect.poll(async () => {
      const dialogVisible = await cardDetailsDialog.isVisible().catch(() => false);
      if (!dialogVisible) {
        await createdCard.getByRole('button', { name: /open card details/i }).click();
        await expect(cardDetailsDialog).toBeVisible({ timeout: 10000 });
      }
      const commentVisible = await cardDetailsDialog.getByText('Looks good').isVisible().catch(() => false);
      const commentImageVisible = await cardDetailsDialog.getByRole('img', { name: 'comment-image.png' }).isVisible().catch(() => false);
      return commentVisible && commentImageVisible;
    }, { timeout: 20000, intervals: [1000, 2000, 3000] }).toBe(true);

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

  test('link-visible board syncs to another browser in realtime', async ({ page, browser }) => {
    test.setTimeout(120000);
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await useLocalRelay(page);
    await configureBlossomServers(page);
    await ensureLoggedIn(page, 30000);
    await enableOthersPool(page, 10);
    await waitForRelayConnected(page, 30000);

    const boardName = `E2E Live Sync ${Date.now()}`;
    const shareUrl = await createBoard(page, boardName, 'link-visible');
    expect(shareUrl).toMatch(/\?k=/);
    const { npub: ownerNpub, treeName } = parseBoardShareUrl(shareUrl);
    await waitForTreePublished(page, ownerNpub, treeName, 45000);
    const ownerRoot = await getTreeRootHex(page, ownerNpub, treeName);

    const page1Todo = page.getByTestId('board-column-Todo');
    await expect(page1Todo).toBeVisible({ timeout: 15000 });
    await flushPendingPublishes(page);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await setupFreshBoardsViewer(page, page2, shareUrl);
    await ensureViewerTreeRoot(page2, ownerNpub, treeName, ownerRoot, 90000);

    await expect(page2.getByRole('heading', { name: boardName })).toBeVisible({ timeout: 30000 });
    await expect(page2.locator('text=Read-only')).toBeVisible({ timeout: 30000 });
    await expect(page2.getByTestId('board-column-Todo')).toBeVisible({ timeout: 60000 });
    await expect(page2.getByRole('button', { name: /permissions/i })).toBeVisible({ timeout: 15000 });

    await page2.getByRole('button', { name: /permissions/i }).click();
    const page2PermissionsDialog = page2.getByRole('dialog', { name: 'Board Permissions' });
    await expect(page2.getByRole('heading', { name: 'Board Permissions' })).toBeVisible({ timeout: 10000 });
    await expect(page2.getByText(/share your npub with an admin to request write access/i)).toBeVisible({ timeout: 10000 });
    await expect(page2.getByPlaceholder('npub1...')).toHaveCount(0);
    await expect(page2PermissionsDialog.getByRole('button', { name: /^add\b/i })).toHaveCount(0);
    await page2PermissionsDialog.getByRole('button', { name: /^close$/i }).first().click();
    await expect(page2.getByRole('heading', { name: 'Board Permissions' })).toHaveCount(0);

    const cardCreateRoot = await getCurrentRootSignature(page);
    await page1Todo.getByRole('button', { name: /add card/i }).click();
    await expect(page.getByRole('heading', { name: 'Create Card' })).toBeVisible({ timeout: 10000 });
    await page.getByLabel('Card title').fill('Realtime card');
    await page.getByLabel('Card description').fill('Should appear in browser 2 without reload.');
    await page.getByRole('button', { name: /^create card$/i }).click();
    await expect(page.getByTestId('board-card-Realtime card')).toBeVisible({ timeout: 10000 });
    await flushBoardRootUpdate(page, cardCreateRoot);
    const updatedOwnerCardCreateRoot = await getTreeRootHex(page, ownerNpub, treeName);

    await ensureViewerTreeRoot(page2, ownerNpub, treeName, updatedOwnerCardCreateRoot, 90000);
    await expect(page2.getByTestId('board-card-Realtime card')).toBeVisible({ timeout: 90000 });

    const cardEditRoot = await getCurrentRootSignature(page);
    await page.getByTestId('board-card-Realtime card').getByRole('button', { name: /open card details/i }).click();
    await page.getByRole('dialog', { name: 'Card details' }).getByRole('button', { name: /edit card/i }).click();
    await expect(page.getByRole('heading', { name: 'Edit Card' })).toBeVisible({ timeout: 10000 });
    await page.getByLabel('Card title').fill('Realtime card updated');
    await page.getByRole('button', { name: /^save card$/i }).click();
    await flushBoardRootUpdate(page, cardEditRoot);
    const updatedOwnerCardEditRoot = await getTreeRootHex(page, ownerNpub, treeName);

    await ensureViewerTreeRoot(page2, ownerNpub, treeName, updatedOwnerCardEditRoot, 90000);
    await expect(page2.getByTestId('board-card-Realtime card updated')).toBeVisible({ timeout: 90000 });
    await expect(page2.getByTestId('board-card-Realtime card')).toHaveCount(0, { timeout: 90000 });

    await context2.close();
  });

  test('granting writer permission updates viewer live and enables editing', async ({ page, browser }) => {
    test.setTimeout(180000);
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await useLocalRelay(page);
    await configureBlossomServers(page);
    await ensureLoggedIn(page, 30000);
    await enableOthersPool(page, 10);
    await waitForRelayConnected(page, 30000);

    const boardName = `E2E Permission Sync ${Date.now()}`;
    const shareUrl = await createBoard(page, boardName, 'link-visible');
    expect(shareUrl).toMatch(/\?k=/);
    const { npub: ownerNpub, treeName } = parseBoardShareUrl(shareUrl);
    await waitForTreePublished(page, ownerNpub, treeName, 45000);
    const ownerRoot = await getTreeRootHex(page, ownerNpub, treeName);
    await flushPendingPublishes(page);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await setupFreshBoardsViewer(page, page2, shareUrl);
    await ensureViewerTreeRoot(page2, ownerNpub, treeName, ownerRoot, 90000);

    const page2Pubkey = await readNostrPubkey(page2);
    expect(typeof page2Pubkey).toBe('string');
    expect((page2Pubkey as string).length).toBe(64);
    const page2Npub = nip19.npubEncode(page2Pubkey as string);

    const page2Todo = page2.getByTestId('board-column-Todo');
    await expect(page2Todo).toBeVisible({ timeout: 60000 });
    await expect(page2.locator('text=Read-only')).toBeVisible({ timeout: 60000 });
    await expect(page2Todo.getByRole('button', { name: /add card/i })).toHaveCount(0);

    const permissionsRoot = await getCurrentRootSignature(page);
    await page.getByRole('button', { name: /permissions/i }).click();
    const permissionsDialog = page.getByRole('dialog', { name: 'Board Permissions' });
    await expect(page.getByRole('heading', { name: 'Board Permissions' })).toBeVisible({ timeout: 10000 });
    await addBoardPermissionEntry(permissionsDialog, page2Npub, 'writer');
    await flushBoardRootUpdate(page, permissionsRoot);
    const updatedOwnerRoot = await getTreeRootHex(page, ownerNpub, treeName);

    await ensureViewerTreeRoot(page2, ownerNpub, treeName, updatedOwnerRoot, 90000);

    await expect.poll(async () => {
      const readOnlyVisible = await page2.getByText('Read-only', { exact: true }).isVisible().catch(() => false);
      const addCardVisible = await page2Todo.getByRole('button', { name: /add card/i }).isVisible().catch(() => false);
      return !readOnlyVisible && addCardVisible;
    }, { timeout: 60000, intervals: [1000, 2000, 3000] }).toBe(true);

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

  test('viewer sees contributor edits live', async ({ page, browser }) => {
    test.setTimeout(180000);
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await useLocalRelay(page);
    await configureBlossomServers(page);
    await ensureLoggedIn(page, 30000);
    await enableOthersPool(page, 10);
    await waitForRelayConnected(page, 30000);

    const boardName = `E2E Contributor Sync ${Date.now()}`;
    const shareUrl = await createBoard(page, boardName, 'link-visible');
    expect(shareUrl).toMatch(/\?k=/);
    const { npub: ownerNpub, treeName } = parseBoardShareUrl(shareUrl);
    await waitForTreePublished(page, ownerNpub, treeName, 45000);
    const ownerRoot = await getTreeRootHex(page, ownerNpub, treeName);
    await flushPendingPublishes(page);

    const writerContext = await browser.newContext();
    const writerPage = await writerContext.newPage();
    await setupFreshBoardsViewer(page, writerPage, shareUrl);
    await ensureViewerTreeRoot(writerPage, ownerNpub, treeName, ownerRoot, 90000);

    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await setupFreshBoardsViewer(page, viewerPage, shareUrl);
    await ensureViewerTreeRoot(viewerPage, ownerNpub, treeName, ownerRoot, 90000);

    const writerPubkey = await readNostrPubkey(writerPage);
    expect(typeof writerPubkey).toBe('string');
    expect((writerPubkey as string).length).toBe(64);
    const writerNpub = nip19.npubEncode(writerPubkey as string);

    const permissionsRoot = await getCurrentRootSignature(page);
    await page.getByRole('button', { name: /permissions/i }).click();
    const contributorPermissionsDialog = page.getByRole('dialog', { name: 'Board Permissions' });
    await expect(page.getByRole('heading', { name: 'Board Permissions' })).toBeVisible({ timeout: 10000 });
    await addBoardPermissionEntry(contributorPermissionsDialog, writerNpub, 'writer');
    await flushBoardRootUpdate(page, permissionsRoot);
    const updatedOwnerRoot = await getTreeRootHex(page, ownerNpub, treeName);

    await ensureViewerTreeRoot(writerPage, ownerNpub, treeName, updatedOwnerRoot, 90000);
    await ensureViewerTreeRoot(viewerPage, ownerNpub, treeName, updatedOwnerRoot, 90000);
    await waitForBoardPermissionEntry(writerPage, writerNpub, 90000);
    await waitForBoardPermissionEntry(viewerPage, writerNpub, 90000);

    const writerTodo = writerPage.getByTestId('board-column-Todo');
    await expect.poll(async () => {
      const addCardVisible = await writerTodo.getByRole('button', { name: /add card/i }).isVisible().catch(() => false);
      const readOnlyVisible = await writerPage.getByText('Read-only', { exact: true }).isVisible().catch(() => false);
      return addCardVisible && !readOnlyVisible;
    }, { timeout: 60000, intervals: [1000, 2000, 3000] }).toBe(true);

    await expect(viewerPage.getByText('Read-only', { exact: true })).toBeVisible({ timeout: 30000 });

    const writerCreateRoot = await getTreeRootSignature(writerPage, writerNpub, treeName);
    await writerTodo.getByRole('button', { name: /add card/i }).click();
    await expect(writerPage.getByRole('heading', { name: 'Create Card' })).toBeVisible({ timeout: 10000 });
    await writerPage.getByLabel('Card title').fill('Contributor live card');
    await writerPage.getByLabel('Card description').fill('Created by a contributor and should appear for viewers.');
    await writerPage.getByRole('button', { name: /^create card$/i }).click();
    await expect(writerPage.getByTestId('board-card-Contributor live card')).toBeVisible({ timeout: 10000 });
    await flushTreeRootUpdate(writerPage, writerNpub, treeName, writerCreateRoot, 45000);
    await waitForTreePublished(writerPage, writerNpub, treeName, 45000);
    const writerRootAfterCreate = await getTreeRootHex(writerPage, writerNpub, treeName);

    await expect.poll(async () => {
      return viewerPage.evaluate(async ({ contributorNpub, contributorTree }) => {
        const { getTreeRoot } = await import('/src/stores/index.ts');
        const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
        const root = await getTreeRoot(contributorNpub, contributorTree, params.get('k'));
        return root ? 'ready' : 'pending';
      }, { contributorNpub: writerNpub, contributorTree: treeName });
    }, { timeout: 60000, intervals: [1000, 2000, 3000] }).toBe('ready');
    await waitForTreeRootHash(viewerPage, writerNpub, treeName, writerRootAfterCreate.hashHex, 60000);
    await ensureViewerTreeRoot(viewerPage, writerNpub, treeName, writerRootAfterCreate, 90000);

    await expect(viewerPage.getByTestId('board-card-Contributor live card')).toBeVisible({ timeout: 60000 });

    const writerEditRoot = await getTreeRootSignature(writerPage, writerNpub, treeName);
    await writerPage.getByTestId('board-card-Contributor live card').getByRole('button', { name: /open card details/i }).click();
    await writerPage.getByRole('dialog', { name: 'Card details' }).getByRole('button', { name: /edit card/i }).click();
    await expect(writerPage.getByRole('heading', { name: 'Edit Card' })).toBeVisible({ timeout: 10000 });
    await writerPage.getByLabel('Card title').fill('Contributor live card updated');
    await writerPage.getByRole('button', { name: /^save card$/i }).click();
    await expect(writerPage.getByTestId('board-card-Contributor live card updated')).toBeVisible({ timeout: 10000 });
    await flushTreeRootUpdate(writerPage, writerNpub, treeName, writerEditRoot, 45000);
    await waitForTreePublished(writerPage, writerNpub, treeName, 45000);
    const writerRootAfterEdit = await getTreeRootHex(writerPage, writerNpub, treeName);
    await ensureViewerTreeRoot(viewerPage, writerNpub, treeName, writerRootAfterEdit, 90000);

    await expect(viewerPage.getByTestId('board-card-Contributor live card updated')).toBeVisible({ timeout: 60000 });
    await expect(viewerPage.getByTestId('board-card-Contributor live card')).toHaveCount(0, { timeout: 60000 });

    await viewerContext.close();
    await writerContext.close();
  });

  test('viewer loads board promptly even when missing writers are listed', async ({ page, browser }) => {
    test.setTimeout(120000);
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await useLocalRelay(page);
    await configureBlossomServers(page);
    await ensureLoggedIn(page, 30000);
    await enableOthersPool(page, 10);
    await waitForRelayConnected(page, 30000);

    const boardName = `E2E Fast Open ${Date.now()}`;
    const shareUrl = await createBoard(page, boardName, 'link-visible');
    expect(shareUrl).toMatch(/\?k=/);
    const { npub: ownerNpub, treeName } = parseBoardShareUrl(shareUrl);
    await waitForTreePublished(page, ownerNpub, treeName, 45000);

    const missingWriterPubkeys = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
    await page.getByRole('button', { name: /permissions/i }).click();
    const fastOpenPermissionsDialog = page.getByRole('dialog', { name: 'Board Permissions' });
    await expect(page.getByRole('heading', { name: 'Board Permissions' })).toBeVisible({ timeout: 10000 });
    for (const pubkey of missingWriterPubkeys) {
      const signatureBefore = await getCurrentRootSignature(page);
      await addBoardPermissionEntry(fastOpenPermissionsDialog, nip19.npubEncode(pubkey), 'writer');
      await flushBoardRootUpdate(page, signatureBefore);
    }
    await fastOpenPermissionsDialog.getByRole('button', { name: /^close$/i }).first().click();
    await waitForTreePublished(page, ownerNpub, treeName, 45000);
    const updatedOwnerRoot = await getTreeRootHex(page, ownerNpub, treeName);

    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await setupFreshBoardsViewer(page, viewerPage, shareUrl);
    await ensureViewerTreeRoot(viewerPage, ownerNpub, treeName, updatedOwnerRoot, 90000);

    await expect(viewerPage.getByRole('heading', { name: boardName })).toBeVisible({ timeout: 5000 });
    await expect(viewerPage.getByTestId('board-column-Todo')).toBeVisible({ timeout: 5000 });

    await viewerContext.close();
  });

  test('non-owner sees link-required notice instead of placeholder board without link key', async ({ page, browser }) => {
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await ensureLoggedIn(page, 30000);
    await enableOthersPool(page, 10);
    await waitForRelayConnected(page, 30000);

    const boardName = `E2E Locked Link Board ${Date.now()}`;
    const shareUrl = await createBoard(page, boardName, 'link-visible');
    expect(shareUrl).toMatch(/\?k=/);
    const { npub: ownerNpub, treeName } = parseBoardShareUrl(shareUrl);
    await waitForTreePublished(page, ownerNpub, treeName, 45000);
    await flushPendingPublishes(page);

    const protectedUrl = shareUrl.replace(/\?k=[^&]+/, '');

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await setupFreshBoardsViewer(page, page2, protectedUrl);

    await expect(page2.getByText('Link Required')).toBeVisible({ timeout: 30000 });
    await expect(page2.getByText('This board requires a special link to access. Ask the owner for the link with the access key.')).toBeVisible({ timeout: 30000 });
    await expect(page2.getByTestId('board-column-Todo')).toHaveCount(0);

    await context2.close();
  });

  test('non-owner sees private-board notice instead of placeholder board', async ({ page, browser }) => {
    setupPageErrorHandler(page);
    await page.goto('/boards.html#/');
    await waitForAppReady(page);
    await ensureLoggedIn(page, 30000);
    await enableOthersPool(page, 10);
    await waitForRelayConnected(page, 30000);

    const boardName = `E2E Private Locked Board ${Date.now()}`;
    const shareUrl = await createBoard(page, boardName, 'private');
    const { npub: ownerNpub, treeName } = parseBoardShareUrl(shareUrl);
    await waitForTreePublished(page, ownerNpub, treeName, 45000);
    await flushPendingPublishes(page);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await setupFreshBoardsViewer(page, page2, shareUrl);

    await expect(page2.getByText('Private Board')).toBeVisible({ timeout: 30000 });
    await expect(page2.getByText('This board is private and can only be accessed by its owner.')).toBeVisible({ timeout: 30000 });
    await expect(page2.getByTestId('board-column-Todo')).toHaveCount(0);

    await context2.close();
  });
});
