import { test, expect, getInvocationsFor } from './fixtures';

test.describe('Navigation', () => {
  test('home button closes webview and shows launcher', async ({ tauriPage: page }) => {
    await page.goto('/');

    // Navigate to a URL first
    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('https://example.com');
    await input.press('Enter');

    // Launcher should be hidden
    await expect(page.getByRole('heading', { name: 'Suggestions' })).not.toBeVisible();

    // Click home button
    await page.getByTitle('Home').click();

    // close_webview should have been called
    const closeCalls = await getInvocationsFor(page, 'close_webview');
    expect(closeCalls.length).toBeGreaterThan(0);

    // Launcher should be visible again
    await expect(page.getByRole('heading', { name: 'Suggestions' })).toBeVisible();

    // Address bar should be cleared
    const inputValue = await input.inputValue();
    expect(inputValue).toBe('');
  });

  test('settings button shows settings page', async ({ tauriPage: page }) => {
    await page.goto('/');

    await page.getByTitle('Settings').click();

    await expect(page.getByText('Settings')).toBeVisible();
    await expect(page.getByText('Launch at startup')).toBeVisible();
    await expect(page.getByText('Daemon')).toBeVisible();
  });

  test('back button from settings returns to launcher', async ({ tauriPage: page }) => {
    await page.goto('/');

    // Go to settings
    await page.getByTitle('Settings').click();
    await expect(page.getByText('Launch at startup')).toBeVisible();

    // Click back
    await page.getByTitle('Back').click();

    // Should be on launcher
    await expect(page.getByRole('heading', { name: 'Suggestions' })).toBeVisible();
  });

  test('address bar updates when navigating', async ({ tauriPage: page }) => {
    await page.goto('/');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('https://example.com');
    await input.press('Enter');

    // Address bar should show URL without protocol
    const value = await input.inputValue();
    expect(value).toBe('example.com');
  });
});
