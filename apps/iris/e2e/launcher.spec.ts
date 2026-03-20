import { test, expect, setupPageErrorHandler, gotoHome } from './fixtures';
import { distributedOwner } from '../src/lib/apps';

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
    const createCalls = invocations.filter((i: any) => i.cmd === 'create_htree_webview');
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].args.host).toBe(distributedOwner);
    expect(createCalls[0].args.treename).toBe('files');
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

  test('add to favourites button works', async ({ tauriPage: page }) => {
    await openHome(page);
    await page.evaluate(() => localStorage.setItem('iris:apps', JSON.stringify([])));
    await page.reload();
    await gotoHome(page);

    await expect(page.getByText('No favourites yet')).toBeVisible();

    await page.locator('button[title="Add to favourites"]').first().click();

    await expect(page.getByText('No favourites yet')).not.toBeVisible();
  });
});
