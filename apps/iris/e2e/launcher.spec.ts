import {
  test,
  expect,
  emitTauriEvent,
  getInvocationsFor,
  setupPageErrorHandler,
  gotoHome,
} from './fixtures';
import { distributedOwner, getSuggestedTreeRootHint } from '../src/lib/apps';

async function openHome(page: import('@playwright/test').Page) {
  setupPageErrorHandler(page);
  await gotoHome(page);
}

test.describe('App Launcher', () => {
  test('shows launcher on startup', async ({ tauriPage: page }) => {
    await openHome(page);

    const favourites = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Favourites' }),
    });
    const suggestions = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Suggestions' }),
    });

    await expect(page.getByRole('heading', { name: 'Favourites' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Suggestions' })).toBeVisible();
    await expect(page.getByText('No favourites yet')).toBeVisible();

    await expect(favourites.getByText('Iris Files')).not.toBeVisible();
    await expect(favourites.getByText('Iris Video')).not.toBeVisible();
    await expect(favourites.getByText('Iris Docs')).not.toBeVisible();
    await expect(favourites.getByText('Iris Git')).not.toBeVisible();
    await expect(favourites.getByText('Iris Maps')).not.toBeVisible();
    await expect(favourites.getByText('Iris Boards')).not.toBeVisible();

    await expect(suggestions.getByText('Iris Files')).toBeVisible();
    await expect(suggestions.getByText('Iris Video')).toBeVisible();
    await expect(suggestions.getByText('Iris Docs')).toBeVisible();
    await expect(suggestions.getByText('Iris Git')).toBeVisible();
    await expect(suggestions.getByText('Iris Maps')).toBeVisible();
    await expect(suggestions.getByText('Iris Boards')).toBeVisible();
    await expect(suggestions.getByText('hashtree.cc')).toBeVisible();
    await expect(suggestions.getByText('Iris Social')).toBeVisible();

    const hashtreeSuggestion = suggestions.locator('[role="button"]').filter({
      has: page.getByText('hashtree.cc'),
    });
    await expect(hashtreeSuggestion.locator('img')).toHaveAttribute('src', /hashtree-cc-favicon\.svg$/);
  });

  test('clicking suggestion triggers webview creation', async ({ tauriPage: page }) => {
    await openHome(page);

    const suggestions = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Suggestions' }),
    });
    await suggestions.getByText('Iris Files').click();

    const invocations = await page.evaluate(() => (window as any).__tauriInvocations);
    const cacheCalls = invocations.filter((i: any) => i.cmd === 'cache_tree_root');
    const createCalls = invocations.filter((i: any) => i.cmd === 'create_htree_webview');
    const treeRootHint = getSuggestedTreeRootHint(distributedOwner, 'files');

    expect(cacheCalls.length).toBe(1);
    expect(cacheCalls[0].args.npub).toBe(distributedOwner);
    expect(cacheCalls[0].args.treeName).toBe('files');
    expect(cacheCalls[0].args.hash).toBe(treeRootHint?.hash);
    expect(cacheCalls[0].args.nhash).toBe(treeRootHint?.nhash);
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].args.host).toBe(distributedOwner);
    expect(createCalls[0].args.nhash).toBeNull();
    expect(createCalls[0].args.npub).toBe(distributedOwner);
    expect(createCalls[0].args.treename).toBe('files');
    expect(createCalls[0].args.path).toBe('/');
  });

  test('typing a suggested htree url does not prewarm the tree root hint', async ({ tauriPage: page }) => {
    await openHome(page);

    const addressInput = page.locator('[data-testid="address-bar"] input');
    await addressInput.click();
    await addressInput.fill(`htree://${distributedOwner}/video`);
    await addressInput.press('Enter');

    const invocations = await page.evaluate(() => (window as any).__tauriInvocations);
    const cacheCalls = invocations.filter((i: any) => i.cmd === 'cache_tree_root');
    const createCalls = invocations.filter((i: any) => i.cmd === 'create_htree_webview');

    expect(cacheCalls.length).toBe(0);
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].args.host).toBe(distributedOwner);
    expect(createCalls[0].args.treename).toBe('video');
    expect(createCalls[0].args.path).toBe('/');
  });

  test('clicking Iris Boards suggestion opens boards tree', async ({ tauriPage: page }) => {
    await openHome(page);

    const suggestions = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Suggestions' }),
    });
    await suggestions.getByText('Iris Boards').click();

    const invocations = await page.evaluate(() => (window as any).__tauriInvocations);
    const createCalls = invocations.filter((i: any) => i.cmd === 'create_htree_webview');
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].args.host).toBe(distributedOwner);
    expect(createCalls[0].args.treename).toBe('boards');
    expect(createCalls[0].args.path).toBe('/');
  });

  test('clicking Iris Git suggestion opens git tree', async ({ tauriPage: page }) => {
    await openHome(page);

    const suggestions = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Suggestions' }),
    });
    await suggestions.getByText('Iris Git').click();

    const invocations = await page.evaluate(() => (window as any).__tauriInvocations);
    const createCalls = invocations.filter((i: any) => i.cmd === 'create_htree_webview');
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].args.host).toBe(distributedOwner);
    expect(createCalls[0].args.treename).toBe('git');
    expect(createCalls[0].args.path).toBe('/');
  });

  test('blank built-in suggestion load clears stale cache and recreates the webview once', async ({ tauriPage: page }) => {
    await openHome(page);

    const suggestions = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Suggestions' }),
    });
    await suggestions.getByText('Iris Video').click();

    await emitTauriEvent(page, 'child-webview-page-load', {
      label: 'content',
      url: `htree://${distributedOwner}/video`,
      event: 'finished',
    });

    await expect.poll(async () => {
      return {
        cacheCalls: (await getInvocationsFor(page, 'cache_tree_root')).length,
        clearCalls: (await getInvocationsFor(page, 'clear_tree_root_cache')).length,
        closeCalls: (await getInvocationsFor(page, 'close_webview')).length,
        createCalls: (await getInvocationsFor(page, 'create_htree_webview')).length,
      };
    }).toEqual({
      cacheCalls: 1,
      clearCalls: 1,
      closeCalls: 1,
      createCalls: 2,
    });

    const clearCalls = await getInvocationsFor(page, 'clear_tree_root_cache');
    expect(clearCalls[0].args.npub).toBe(distributedOwner);
    expect(clearCalls[0].args.treeName).toBe('video');

    const createCalls = await getInvocationsFor(page, 'create_htree_webview');
    expect(createCalls[1].args.host).toBe(distributedOwner);
    expect(createCalls[1].args.treename).toBe('video');
    expect(createCalls[1].args.path).toBe('/');
  });

  test('stalled htree suggestion load recreates the webview with plain loopback transport', async ({ tauriPage: page }) => {
    await openHome(page);

    const suggestions = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Suggestions' }),
    });
    await suggestions.getByText('Iris Video').click();

    await expect.poll(async () => {
      return {
        closeCalls: (await getInvocationsFor(page, 'close_webview')).length,
        createCalls: (await getInvocationsFor(page, 'create_htree_webview')).length,
      };
    }, { timeout: 5000 }).toEqual({
      closeCalls: 1,
      createCalls: 2,
    });

    const createCalls = await getInvocationsFor(page, 'create_htree_webview');
    expect(createCalls[0].args.preferPlainLoopbackHost).toBe(false);
    expect(createCalls[1].args.host).toBe(distributedOwner);
    expect(createCalls[1].args.treename).toBe('video');
    expect(createCalls[1].args.path).toBe('/');
    expect(createCalls[1].args.preferPlainLoopbackHost).toBe(true);
  });

  test('dismissed suggestions stay hidden after reload', async ({ tauriPage: page }) => {
    await openHome(page);

    const suggestions = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Suggestions' }),
    });
    const gitSuggestion = suggestions.locator('[role="button"]').filter({
      has: page.getByText('Iris Git'),
    });

    await expect(gitSuggestion).toBeVisible();
    await gitSuggestion.getByTitle('Dismiss suggestion').click();
    await expect(gitSuggestion).not.toBeVisible();

    await page.reload();
    await gotoHome(page);

    await expect(suggestions.getByText('Iris Git')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset suggestions' })).toBeVisible();
  });

  test('reset suggestions restores dismissed suggestions', async ({ tauriPage: page }) => {
    await openHome(page);

    const suggestions = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Suggestions' }),
    });
    const boardsSuggestion = suggestions.locator('[role="button"]').filter({
      has: page.getByText('Iris Boards'),
    });

    await boardsSuggestion.getByTitle('Dismiss suggestion').click();
    await expect(boardsSuggestion).not.toBeVisible();

    await page.getByRole('button', { name: 'Reset suggestions' }).click();

    await expect(suggestions.getByText('Iris Boards')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset suggestions' })).not.toBeVisible();
  });

  test('add to favourites button works', async ({ tauriPage: page }) => {
    await openHome(page);
    await page.evaluate(() => localStorage.setItem('iris:apps', JSON.stringify([])));
    await page.reload();
    await gotoHome(page);

    const favourites = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Favourites' }),
    });
    const suggestions = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Suggestions' }),
    });

    await expect(page.getByText('No favourites yet')).toBeVisible();

    const filesSuggestion = suggestions.locator('[role="button"]').filter({
      has: page.getByText('Iris Files'),
    });
    await filesSuggestion.getByTitle('Add to favourites').click();

    await expect(page.getByText('No favourites yet')).not.toBeVisible();
    await expect(favourites.getByText('Iris Files')).toBeVisible();
    await expect(suggestions.getByText('Iris Files')).not.toBeVisible();
  });
});
