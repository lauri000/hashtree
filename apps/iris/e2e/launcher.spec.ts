import { test, expect } from './fixtures';

test.describe('App Launcher', () => {
  test('shows launcher on startup', async ({ tauriPage: page }) => {
    await page.goto('/');

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
    await page.goto('/');

    await page.getByText('Iris Files').click();

    // Should have invoked create_nip07_webview
    const invocations = await page.evaluate(() => (window as any).__tauriInvocations);
    const createCalls = invocations.filter((i: any) => i.cmd === 'create_nip07_webview');
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].args.url).toBe('https://files.iris.to');
  });

  test('add to favourites button works', async ({ tauriPage: page }) => {
    // Clear any stored favourites
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('iris:apps'));
    await page.reload();

    // Click the + button on the first suggestion
    await page.locator('button[title="Add to favourites"]').first().click();

    // Should no longer show "No favourites yet"
    await expect(page.getByText('No favourites yet')).not.toBeVisible();
  });
});
