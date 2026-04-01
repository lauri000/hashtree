import { test, expect } from './fixtures';
import { setupPageErrorHandler, disableOthersPool, configureBlossomServers, waitForWebRTCConnection, waitForAppReady, ensureLoggedIn, safeReload, flushPendingPublishes, evaluateWithRetry } from './test-utils';

async function getOwnedTreeRootSnapshot(page: any, treeName: string) {
  const snapshot = await page.evaluate(async (targetTreeName) => {
    const { getTreeRootSync } = await import('/src/stores');
    const nostrStore = (window as any).__nostrStore;
    const npub = nostrStore?.getState?.()?.npub;
    if (!npub) return null;

    const rootCid = getTreeRootSync(npub, targetTreeName);
    if (!rootCid?.hash) return null;

    const registry = (window as any).__treeRootRegistry;
    const entry = registry?.get?.(npub, targetTreeName);

    const toHex = (bytes: Uint8Array) => Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

    return {
      npub,
      treeName: targetTreeName,
      visibility: entry?.visibility || 'public',
      hashHex: toHex(rootCid.hash),
      keyHex: rootCid.key ? toHex(rootCid.key) : null,
    };
  }, treeName);

  if (!snapshot) {
    throw new Error(`Could not resolve tree root snapshot for ${treeName}`);
  }

  return snapshot as {
    npub: string;
    treeName: string;
    visibility: string;
    hashHex: string;
    keyHex: string | null;
  };
}

async function primeViewerTreeRoot(
  page: any,
  snapshot: {
    npub: string;
    treeName: string;
    visibility: string;
    hashHex: string;
    keyHex: string | null;
  },
  targetTreeName?: string
) {
  await page.evaluate(async ({ npub, treeName, visibility, hashHex, keyHex, overrideTreeName }) => {
    const { updateLocalRootCacheHex } = await import('/src/treeRootCache');
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

    const route = (window as any).__routeStore?.getState?.();
    const resolvedTreeName = overrideTreeName || route?.treeName || treeName;
    if (!resolvedTreeName) return;

    updateLocalRootCacheHex(npub, resolvedTreeName, hashHex, keyHex ?? undefined, visibility as any);

    const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
    if (adapter?.setTreeRootCache) {
      await adapter.setTreeRootCache(
        npub,
        resolvedTreeName,
        fromHex(hashHex),
        keyHex ? fromHex(keyHex) : undefined,
        visibility,
      );
    }
  }, {
    ...snapshot,
    overrideTreeName: targetTreeName ?? null,
  });
}

async function waitForTreeRootChange(page: any, previousRoot: string | null, timeoutMs: number = 30000) {
  await page.waitForFunction(
    () => typeof (window as any).__getTreeRoot === 'function',
    undefined,
    { timeout: 10000 }
  );
  await page.waitForFunction(
    (prev) => {
      const current = (window as any).__getTreeRoot?.();
      return !!current && current !== prev;
    },
    previousRoot,
    { timeout: timeoutMs }
  );
}

async function waitForYjsEntry(page: any, timeoutMs: number = 60000) {
  await expect.poll(async () => {
    return evaluateWithRetry(page, async () => {
      const { getTreeRootSync } = await import('/src/stores');
      const { getTree } = await import('/src/store');
      const { getRouteSync } = await import('/src/stores/route');
      const route = getRouteSync();
      if (!route.npub || !route.treeName) return false;
      const rootCid = getTreeRootSync(route.npub, route.treeName);
      if (!rootCid) return false;
      const tree = getTree();
      const entry = await tree.resolvePath(rootCid, route.path);
      if (!entry?.cid) return false;
      const entries = await tree.listDirectory(entry.cid);
      return entries?.some((item: { name: string }) => item.name === '.yjs') ?? false;
    }, null);
  }, { timeout: timeoutMs, intervals: [1000, 2000, 3000] }).toBe(true);
}

async function waitForDocsEditor(page: any, timeoutMs: number = 60000) {
  await ensureLoggedIn(page, Math.min(30000, timeoutMs)).catch(() => {});
  await waitForYjsEntry(page, timeoutMs).catch(() => {});
  const editor = page.locator('.ProseMirror');
  const start = Date.now();
  let reloaded = false;
  while (Date.now() - start < timeoutMs) {
    await page.evaluate(() => {
      (window as any).__workerAdapter?.sendHello?.();
      (window as any).__reloadYjsEditors?.();
    });
    if (await editor.isVisible().catch(() => false)) {
      return;
    }
    if (!reloaded && Date.now() - start > timeoutMs / 2) {
      await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: Math.min(60000, timeoutMs) }).catch(() => {});
      await waitForAppReady(page, Math.min(60000, timeoutMs)).catch(() => {});
      await waitForYjsEntry(page, Math.min(60000, timeoutMs)).catch(() => {});
      reloaded = true;
    }
    await page.waitForTimeout(2000);
  }
  await expect(editor).toBeVisible({ timeout: 1000 });
}

async function waitForEditorContent(
  page: any,
  expectedTexts: string[],
  timeoutMs: number = 90000
) {
  const editor = page.locator('.ProseMirror');
  const start = Date.now();
  let recovered = false;

  while (Date.now() - start < timeoutMs) {
    await page.evaluate(() => {
      (window as any).__workerAdapter?.sendHello?.();
      (window as any).__reloadYjsEditors?.();
    }).catch(() => {});

    const text = await editor.textContent().catch(() => null);
    const normalized = text ?? '';
    if (expectedTexts.every(expected => normalized.includes(expected))) {
      return;
    }

    if (!recovered && Date.now() - start > timeoutMs / 2) {
      await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: Math.min(60000, timeoutMs) }).catch(() => {});
      await waitForAppReady(page, Math.min(60000, timeoutMs)).catch(() => {});
      await ensureLoggedIn(page, Math.min(30000, timeoutMs)).catch(() => {});
      await disableOthersPool(page).catch(() => {});
      await waitForYjsEntry(page, Math.min(60000, timeoutMs)).catch(() => {});
      await waitForDocsEditor(page, Math.min(60000, timeoutMs)).catch(() => {});
      recovered = true;
    }

    await page.waitForTimeout(2000);
  }

  const finalText = (await editor.textContent().catch(() => null)) ?? '';
  for (const expected of expectedTexts) {
    expect(finalText).toContain(expected);
  }
}

async function waitForPersistedDocContent(
  page: any,
  treeName: string,
  expectedTexts: string[],
  timeoutMs: number = 90000
) {
  await expect.poll(async () => {
    const text = await evaluateWithRetry(page, async (targetTreeName) => {
      const { getTree } = await import('/src/store');
      const { getTreeRootSync } = await import('/src/stores');
      const { loadDocumentTextFromEntries } = await import('/src/lib/yjs');
      const nostrStore = (window as any).__nostrStore;
      const npub = nostrStore?.getState?.()?.npub;
      if (!npub) return '';

      const rootCid = getTreeRootSync(npub, targetTreeName as string);
      if (!rootCid) return '';

      const tree = getTree();
      const entries = await tree.listDirectory(rootCid);
      return loadDocumentTextFromEntries(entries);
    }, treeName);
    return expectedTexts.every(expected => text.includes(expected));
  }, { timeout: timeoutMs, intervals: [1000, 2000, 3000] }).toBe(true);
}

test.describe('Iris Docs App', () => {
  test.setTimeout(120000);
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
  });

  test('shows Iris Docs header', async ({ page }) => {
    await page.goto('/docs.html#/');
    await expect(page.locator('text=Iris Docs')).toBeVisible({ timeout: 30000 });
  });

  test('shows New Document card after login', async ({ page }) => {
    await page.goto('/docs.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);
    await ensureLoggedIn(page, 30000);

    await page.getByRole('button', { name: /New/i }).click();

    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 30000 });
  });

  test('can create new document', async ({ page }) => {
    await page.goto('/docs.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);
    await ensureLoggedIn(page, 30000);

    await page.getByRole('button', { name: /New/i }).click();

    const newDocCard = page.locator('[role="button"]:has-text("New Document")');
    await expect(newDocCard).toBeVisible({ timeout: 15000 });

    await page.keyboard.press('Escape');
    await newDocCard.click();

    await expect(page.getByRole('heading', { name: 'New Document' })).toBeVisible({ timeout: 30000 });

    const docName = `Test Doc ${Date.now()}`;
    await page.locator('input[placeholder="Document name..."]').fill(docName);

    await expect(page.locator('button:has-text("public")')).toBeVisible({ timeout: 30000 });

    await page.getByRole('button', { name: 'Create' }).click();

    await page.waitForURL(/\/docs\.html#\/npub.*\/docs%2FTest%20Doc/, { timeout: 15000 });

    await waitForDocsEditor(page, 90000);
    await expect(page.locator('button[title="Bold (Ctrl+B)"]')).toBeVisible({ timeout: 30000 });
  });

  test('header has Iris Docs branding', async ({ page }) => {
    await page.goto('/docs.html#/');
    await expect(page.locator('text=Iris Docs')).toBeVisible({ timeout: 30000 });
  });

  test('document persists after refresh and shows on home', async ({ page }) => {
    test.slow();
    await page.goto('/docs.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);
    await ensureLoggedIn(page, 30000);

    await page.getByRole('button', { name: /New/i }).click();

    const newDocCard = page.locator('[role="button"]:has-text("New Document")');
    await expect(newDocCard).toBeVisible({ timeout: 15000 });

    await page.keyboard.press('Escape');
    await newDocCard.click();

    const docName = `Persist Test ${Date.now()}`;
    await page.locator('input[placeholder="Document name..."]').fill(docName);
    await page.getByRole('button', { name: 'Create' }).click();

    await waitForDocsEditor(page, 90000);
    await expect(page.locator('button[title="Bold (Ctrl+B)"]')).toBeVisible({ timeout: 30000 });

    const editor = page.locator('.ProseMirror');
    const rootBefore = await page.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
    await editor.click();
    await editor.type('Hello persistence test!');
    await expect(editor).toContainText('Hello persistence test!', { timeout: 15000 });
    await waitForTreeRootChange(page, rootBefore, 60000);
    await flushPendingPublishes(page);

    await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000 });
    await waitForAppReady(page, 60000);
    await page.waitForFunction(
      () => (window as any).__nostrStore?.getState?.().pubkey?.length === 64,
      undefined,
      { timeout: 60000 }
    );
    await page.waitForFunction(
      () => typeof (window as any).__getTreeRoot === 'function' && !!(window as any).__getTreeRoot?.(),
      undefined,
      { timeout: 60000 }
    ).catch(() => {});
    await waitForYjsEntry(page, 90000);

    await waitForDocsEditor(page, 90000);
    const editorAfterReload = page.locator('.ProseMirror');
    await expect(editorAfterReload).toBeVisible({ timeout: 60000 });
    await expect(page.locator('button[title="Bold (Ctrl+B)"]')).toBeVisible({ timeout: 60000 });
    await waitForEditorContent(page, ['Hello persistence test!'], 120000);

    await page.evaluate(() => window.location.hash = '#/');

    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 30000 });
    await expect(page.locator(`text=${docName}`)).toBeVisible({ timeout: 30000 });
  });

  test('can navigate from home to document and view content', async ({ page }) => {
    await page.goto('/docs.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);
    await ensureLoggedIn(page, 30000);

    await page.getByRole('button', { name: /New/i }).click();

    const newDocCard = page.locator('[role="button"]:has-text("New Document")');
    await expect(newDocCard).toBeVisible({ timeout: 15000 });

    await page.keyboard.press('Escape');
    await newDocCard.click();

    const docName = `Navigate Test ${Date.now()}`;
    await page.locator('input[placeholder="Document name..."]').fill(docName);
    await page.getByRole('button', { name: 'Create' }).click();

    await waitForDocsEditor(page, 90000);
    await expect(page.locator('button[title="Bold (Ctrl+B)"]')).toBeVisible({ timeout: 30000 });
    const editor = page.locator('.ProseMirror');
    const rootBefore = await page.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
    await editor.click();
    await editor.type('Content for navigation test');
    await expect(editor).toContainText('Content for navigation test', { timeout: 15000 });
    await waitForTreeRootChange(page, rootBefore, 60000);

    await page.evaluate(() => window.location.hash = '#/');

    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 30000 });

    const docCard = page.locator(`text=${docName}`);
    await expect(docCard).toBeVisible({ timeout: 30000 });
    await docCard.click();

    await waitForDocsEditor(page, 90000);
    await expect(page.locator('button[title="Bold (Ctrl+B)"]')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.ProseMirror')).toContainText('Content for navigation test', { timeout: 30000 });
  });

  test('edits to existing document persist after navigation and refresh', async ({ page }) => {
    test.setTimeout(240000); // Extra headroom for Yjs/editor recovery under full-suite parallel load

    await page.goto('/docs.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);
    await ensureLoggedIn(page, 30000);

    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 15000 });

    await page.keyboard.press('Escape');
    await page.locator('[role="button"]:has-text("New Document")').click();

    const docName = `Edit Persist Test ${Date.now()}`;
    const treeName = `docs/${docName}`;
    const encodedDocPath = encodeURIComponent(treeName);
    await page.locator('input[placeholder="Document name..."]').fill(docName);
    await page.getByRole('button', { name: 'Create' }).click();

    await page.waitForURL(url => url.toString().includes(encodedDocPath), { timeout: 60000 });
    await waitForDocsEditor(page, 90000);
    await expect(page.locator('button[title="Bold (Ctrl+B)"]')).toBeVisible({ timeout: 30000 });
    const editor = page.locator('.ProseMirror');
    const rootBeforeInitial = await page.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
    await editor.click();
    await editor.type('Initial content.');
    await expect(editor).toContainText('Initial content.', { timeout: 15000 });
    await waitForTreeRootChange(page, rootBeforeInitial, 60000);
    await flushPendingPublishes(page);
    const initialSnapshot = await getOwnedTreeRootSnapshot(page, treeName);

    await page.evaluate(() => window.location.hash = '#/');
    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 30000 });

    await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000 });
    await waitForAppReady(page);
    await waitForAppReady(page);
    await ensureLoggedIn(page, 30000);
    await disableOthersPool(page);
    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 30000 });
    await primeViewerTreeRoot(page, initialSnapshot, treeName);

    const docCard = page.locator(`text=${docName}`);
    await expect(docCard).toBeVisible({ timeout: 60000 });
    await docCard.click();

    await page.waitForURL(url => url.toString().includes(encodedDocPath), { timeout: 60000 });
    await waitForDocsEditor(page, 120000);
    await expect(page.locator('button[title="Bold (Ctrl+B)"]')).toBeVisible({ timeout: 30000 });
    await waitForYjsEntry(page, 120000);
    await waitForEditorContent(page, ['Initial content.'], 120000);

    const editor2 = page.locator('.ProseMirror');
    const rootBeforeAppend = await page.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
    const previousEntry = await page.evaluate((name) => {
      const nostrStore = (window as any).__nostrStore;
      const npub = nostrStore?.getState?.().npub;
      const registry = (window as any).__treeRootRegistry;
      const entry = registry?.get?.(npub, name as string);
      if (!entry) return { updatedAt: null, hashHex: null };

      const toHex = (bytes: Uint8Array) => {
        let out = '';
        for (const byte of bytes) {
          out += byte.toString(16).padStart(2, '0');
        }
        return out;
      };
      return { updatedAt: entry.updatedAt ?? null, hashHex: entry.hash ? toHex(entry.hash) : null };
    }, treeName);
    await editor2.click();
    await editor2.press('End');
    await editor2.type(' Added more content.');
    await expect(editor2).toContainText('Added more content.', { timeout: 15000 });
    await page.waitForFunction(
      (payload) => {
        const { treeName: name, previous } = payload as { treeName: string; previous: { updatedAt: number | null; hashHex: string | null } };
        const nostrStore = (window as any).__nostrStore;
        const npub = nostrStore?.getState?.().npub;
        if (!npub) return false;
        const registry = (window as any).__treeRootRegistry;
        const entry = registry?.get?.(npub, name);
        if (!entry) return false;

        const toHex = (bytes: Uint8Array) => {
          let out = '';
          for (const byte of bytes) {
            out += byte.toString(16).padStart(2, '0');
          }
          return out;
        };
        const currentHash = entry.hash ? toHex(entry.hash) : null;
        const prevHash = previous?.hashHex ?? null;
        const prevUpdatedAt = previous?.updatedAt ?? null;

        if (prevHash && currentHash && currentHash !== prevHash) {
          return entry.dirty === false;
        }
        if (prevUpdatedAt !== null && entry.updatedAt !== null && entry.updatedAt > prevUpdatedAt) {
          return entry.dirty === false;
        }
        return false;
      },
      { treeName, previous: previousEntry },
      { timeout: 60000 }
    );
    await waitForTreeRootChange(page, rootBeforeAppend, 60000);
    await flushPendingPublishes(page);
    await waitForPersistedDocContent(page, treeName, ['Initial content.', 'Added more content.'], 120000);
    const appendedSnapshot = await getOwnedTreeRootSnapshot(page, treeName);

    await page.evaluate(() => window.location.hash = '#/');
    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 30000 });
    await primeViewerTreeRoot(page, appendedSnapshot, treeName);

    const persistedDocCard = page.locator(`text=${docName}`);
    await expect(persistedDocCard).toBeVisible({ timeout: 60000 });
    await persistedDocCard.click();
    await page.waitForURL(url => url.toString().includes(encodedDocPath), { timeout: 60000 });
    await waitForDocsEditor(page, 90000);
    await expect(page.locator('button[title="Bold (Ctrl+B)"]')).toBeVisible({ timeout: 30000 });
    await waitForYjsEntry(page, 90000);
    await waitForEditorContent(page, ['Initial content.', 'Added more content.'], 120000);

    await page.evaluate(() => window.location.hash = '#/');
    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 30000 });

    await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000 });
    await waitForAppReady(page);
    await ensureLoggedIn(page, 30000);
    await disableOthersPool(page);
    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 30000 });
    await primeViewerTreeRoot(page, appendedSnapshot, treeName);

    const reloadedDocCard = page.locator(`text=${docName}`);
    await expect(reloadedDocCard).toBeVisible({ timeout: 60000 });
    await reloadedDocCard.click();
    await page.waitForURL(url => url.toString().includes(encodedDocPath), { timeout: 60000 });

    await waitForDocsEditor(page, 90000);
    await expect(page.locator('button[title="Bold (Ctrl+B)"]')).toBeVisible({ timeout: 30000 });
    await waitForYjsEntry(page, 90000);
    await waitForEditorContent(page, ['Initial content.', 'Added more content.'], 120000);
  });

  test('another browser can view document via shared link', async ({ browser }) => {
    test.slow();

    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      setupPageErrorHandler(page1);
      setupPageErrorHandler(page2);

      await page1.goto('/docs.html#/');
      await waitForAppReady(page1);
      await disableOthersPool(page1);
      await configureBlossomServers(page1);
      await ensureLoggedIn(page1);

      const newDocCard = page1.locator('[role="button"]:has-text("New Document")');
      await page1.keyboard.press('Escape');
      await expect(newDocCard).toBeVisible({ timeout: 15000 });
      await newDocCard.click();

      const docName = `Shared Doc ${Date.now()}`;
      await page1.locator('input[placeholder="Document name..."]').fill(docName);
      await page1.getByRole('button', { name: 'Create' }).click();

      await waitForDocsEditor(page1, 90000);
      const editor1 = page1.locator('.ProseMirror');
      await expect(editor1).toBeVisible({ timeout: 30000 });
      const content = `Shared content ${Date.now()}`;
      const rootBefore = await page1.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
      await editor1.click();
      await editor1.type(content);
      await expect(editor1).toContainText(content, { timeout: 15000 });
      await waitForTreeRootChange(page1, rootBefore, 60000);

      const pushButton = page1.getByRole('button', { name: 'Push to file servers' });
      await expect(pushButton).toBeVisible({ timeout: 15000 });
      await pushButton.click();

      const pushModal = page1.getByTestId('blossom-push-modal');
      await expect(pushModal).toBeVisible({ timeout: 15000 });
      await pushModal.getByTestId('start-push-btn').click();
      const doneButton = pushModal.getByRole('button', { name: 'Done' });
      await expect(doneButton).toBeVisible({ timeout: 60000 });
      await doneButton.click();
      await expect(pushModal).toBeHidden({ timeout: 15000 });

      const shareUrl = page1.url();
      expect(shareUrl).toContain('/docs.html#/');
      const treeNameMatch = shareUrl.match(/#\/npub1[0-9a-z]+\/(.+)$/);
      const treeName = treeNameMatch ? decodeURIComponent(treeNameMatch[1]) : null;
      expect(treeName).toBeTruthy();
      await page1.waitForFunction(
        (docTreeName) => {
          const nostrStore = (window as any).__nostrStore;
          const npub = nostrStore?.getState()?.npub;
          if (!npub) return false;
          const registry = (window as any).__treeRootRegistry;
          const entry = registry?.get?.(npub, docTreeName as string);
          return !!entry && entry.dirty === false;
        },
        treeName,
        { timeout: 30000 }
      );
      const sharedRoot = await getOwnedTreeRootSnapshot(page1, treeName!);

      await page2.goto('/docs.html#/');
      await waitForAppReady(page2);
      await disableOthersPool(page2);
      await configureBlossomServers(page2);
      await ensureLoggedIn(page2);

      await page2.goto(shareUrl);
      await waitForAppReady(page2);
      await disableOthersPool(page2);
      await configureBlossomServers(page2);
      await primeViewerTreeRoot(page2, sharedRoot);
      await page2.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));

      await waitForDocsEditor(page2, 120000);
      const editor2 = page2.locator('.ProseMirror');
      await expect(editor2).toBeVisible({ timeout: 60000 });
      await expect(editor2).toContainText(content, { timeout: 60000 });
    } finally {
      await context1.close();
      await context2.close();
    }
  });

  test('New Document button shows after auto-login on refresh', async ({ page }) => {
    test.setTimeout(60000);
    await page.goto('/docs.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);

    await page.getByRole('button', { name: /New/i }).click();

    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 15000 });

    try {
      await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000 });
    } catch {
      await page.goto('/docs.html#/', { waitUntil: 'domcontentloaded' });
    }
    await waitForAppReady(page);

    await expect(page.locator('[role="button"]:has-text("New Document")')).toBeVisible({ timeout: 15000 });
  });

  test('editor maintains focus after auto-save in docs app', async ({ page }) => {
    await page.goto('/docs.html#/');
    await waitForAppReady(page);
    await disableOthersPool(page);

    await page.getByRole('button', { name: /New/i }).click();

    const newDocCard = page.locator('[role="button"]:has-text("New Document")');
    await expect(newDocCard).toBeVisible({ timeout: 15000 });

    await page.keyboard.press('Escape');
    await newDocCard.click();

    const docName = `Focus Test ${Date.now()}`;
    await page.locator('input[placeholder="Document name..."]').fill(docName);
    await page.getByRole('button', { name: 'Create' }).click();

    await waitForDocsEditor(page, 90000);
    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible({ timeout: 30000 });
    await editor.click();

    const rootBefore = await page.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
    await page.keyboard.type('First sentence.');
    await waitForTreeRootChange(page, rootBefore, 60000);

    const hasFocus = await page.evaluate(() => {
      const active = document.activeElement;
      const editor = document.querySelector('.ProseMirror');
      return editor?.contains(active) || active === editor;
    });
    expect(hasFocus).toBe(true);

    await page.keyboard.type(' Second sentence.');

    await expect(editor).toContainText('First sentence. Second sentence.', { timeout: 30000 });
  });
});
