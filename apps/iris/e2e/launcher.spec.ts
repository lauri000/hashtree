import { test, expect, setupPageErrorHandler, gotoHome } from './fixtures';

const distributedOwner = 'npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce';

async function openHome(page: import('@playwright/test').Page) {
  setupPageErrorHandler(page);
  await gotoHome(page);
}

test.describe('App Launcher', () => {
  test('shows launcher on startup', async ({ tauriPage: page }) => {
    await openHome(page);

    // Favourites section visible
    await expect(page.getByRole('heading', { name: 'Favourites' })).toBeVisible();
    await expect(page.getByText('No favourites yet')).toBeVisible();

    // Suggestions section visible with default apps
    await expect(page.getByRole('heading', { name: 'Suggestions' })).toBeVisible();
    await expect(page.getByText('Iris Files')).toBeVisible();
    await expect(page.getByText('Iris Video')).toBeVisible();
    await expect(page.getByText('Iris Social')).toBeVisible();
  });

  test('clicking suggestion triggers webview creation', async ({ tauriPage: page }) => {
    await openHome(page);

    await page.getByText('Iris Files').click();

    const invocations = await page.evaluate(() => (window as any).__tauriInvocations);
    const createCalls = invocations.filter((i: any) => i.cmd === 'create_htree_webview');
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].args.host).toBe(distributedOwner);
    expect(createCalls[0].args.treename).toBe('files');
    expect(createCalls[0].args.path).toBe('/');
  });

  test('add to favourites button works', async ({ tauriPage: page }) => {
    // Clear any stored favourites
    await openHome(page);
    await page.evaluate(() => localStorage.removeItem('iris:apps'));
    await page.reload();
    await gotoHome(page);

    // Click the + button on the first suggestion
    await page.locator('button[title="Add to favourites"]').first().click();

    // Should no longer show "No favourites yet"
    await expect(page.getByText('No favourites yet')).not.toBeVisible();
  });
});
