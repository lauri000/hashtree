import { expect } from './fixtures';
import {
  configureBlossomServers,
  disableOthersPool,
  ensureLoggedIn,
  evaluateWithRetry,
  safeReload,
  waitForAppReady,
} from './test-utils.js';

export async function waitForTreeRootChange(page: any, previousRoot: string | null, timeoutMs: number = 60000) {
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
    }, undefined, 5);
  }, { timeout: timeoutMs, intervals: [1000, 2000, 3000] }).toBe(true);
}

export async function waitForDocsEditor(page: any, timeoutMs: number = 60000) {
  await ensureLoggedIn(page, Math.min(30000, timeoutMs)).catch(() => {});
  await waitForYjsEntry(page, timeoutMs).catch(() => {});
  const editor = page.locator('.ProseMirror');
  const start = Date.now();
  let reloaded = false;
  while (Date.now() - start < timeoutMs) {
    await page.evaluate(() => {
      (window as any).__workerAdapter?.sendHello?.();
      (window as any).__reloadYjsEditors?.();
    }).catch(() => {});
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

export async function setupDocsHome(page: any) {
  await page.goto('/docs.html#/');
  await waitForAppReady(page);
  await disableOthersPool(page);
  await configureBlossomServers(page);
  await ensureLoggedIn(page, 30000);
  await expect(page.locator('[role="button"]:has-text("New Document")').first()).toBeVisible({ timeout: 30000 });
}

export async function openNewDocumentModal(page: any) {
  const newDocCard = page.locator('[role="button"]:has-text("New Document")').first();
  await expect(newDocCard).toBeVisible({ timeout: 30000 });
  await newDocCard.click();
  await expect(page.getByRole('heading', { name: 'New Document' })).toBeVisible({ timeout: 30000 });
}

export async function createDocumentFromDocsHome(page: any, name: string) {
  await openNewDocumentModal(page);
  await page.locator('input[placeholder="Document name..."]').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await waitForDocsEditor(page, 90000);
}

export async function createRegularTreeFromDocsHome(page: any, treeName: string) {
  const npub = await page.evaluate(() => (window as any).__nostrStore?.getState?.()?.npub ?? null);
  if (!npub) {
    throw new Error('Failed to resolve logged-in npub for docs tree creation');
  }

  await page.evaluate(async (name: string) => {
    const { createTree } = await import('/src/actions/tree.ts');
    const result = await createTree(name, 'public', true);
    if (!result.success) {
      throw new Error(`Failed to create tree ${name}`);
    }
  }, treeName);

  await page.goto(`/docs.html#/${npub}/${encodeURIComponent(treeName)}`);
  await waitForAppReady(page);
  await disableOthersPool(page);
  await configureBlossomServers(page);
}

export async function createManualYjsTreeFromDocsHome(page: any, treeName: string) {
  const npub = await page.evaluate(() => (window as any).__nostrStore?.getState?.()?.npub ?? null);
  if (!npub) {
    throw new Error('Failed to resolve logged-in npub for docs tree creation');
  }

  await page.evaluate(async (name: string) => {
    const { createTree } = await import('/src/actions/tree.ts');
    const { getLocalRootEntry } = await import('/src/treeRootCache.ts');
    const { saveHashtree } = await import('/src/nostr.ts');
    const { getTree } = await import('/src/store.ts');
    const { cid: makeCid, LinkType } = await import('/src/lib/nhash.ts');

    const state = (window as any).__nostrStore?.getState?.();
    if (!state?.npub) {
      throw new Error('No logged-in npub');
    }

    const result = await createTree(name, 'public', true);
    if (!result.success) {
      throw new Error(`Failed to create tree ${name}`);
    }

    const entry = getLocalRootEntry(state.npub, name);
    if (!entry) {
      throw new Error(`Missing local root cache entry for ${name}`);
    }

    const tree = getTree();
    const rootCid = makeCid(entry.hash, entry.key);
    const yjsContent = new TextEncoder().encode(`${state.npub}\n`);
    const { cid: yjsFileCid, size } = await tree.putFile(yjsContent);
    const newRootCid = await tree.setEntry(rootCid, [], '.yjs', yjsFileCid, size, LinkType.Blob);
    await saveHashtree(name, newRootCid, { visibility: entry.visibility ?? 'public' });
  }, treeName);

  await page.goto(`/docs.html#/${npub}/${encodeURIComponent(treeName)}`);
  await waitForAppReady(page);
  await disableOthersPool(page);
  await configureBlossomServers(page);
}

export async function currentTreeHasEntry(page: any, entryName: string): Promise<boolean> {
  return evaluateWithRetry(page, async (name: string) => {
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    const { getTree } = await import('/src/store.ts');
    const rootCid = getCurrentRootCid();
    if (!rootCid) return false;
    const entries = await getTree().listDirectory(rootCid);
    return entries.some((entry: { name: string }) => entry.name === name);
  }, entryName, 5);
}
