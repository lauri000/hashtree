import { test, expect, getInvocationsFor, setupPageErrorHandler, gotoHome } from './fixtures';

async function openHome(page: import('@playwright/test').Page) {
  setupPageErrorHandler(page);
  await gotoHome(page);
}

test.describe('Navigation', () => {
  test('home button closes webview and shows launcher', async ({ tauriPage: page }) => {
    await openHome(page);

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
    await openHome(page);

    await page.getByTitle('Settings').click();

    await expect(page.getByText('Settings')).toBeVisible();
    await expect(page.getByText('Launch at startup')).toBeVisible();
    await expect(page.getByText('Daemon')).toBeVisible();
  });

  test('back button from settings returns to launcher', async ({ tauriPage: page }) => {
    await openHome(page);

    // Go to settings
    await page.getByTitle('Settings').click();
    await expect(page.getByText('Launch at startup')).toBeVisible();

    // Click back
    await page.getByTitle('Back').click();

    // Should be on launcher
    await expect(page.getByRole('heading', { name: 'Suggestions' })).toBeVisible();
  });

  test('back and forward buttons are disabled when no history', async ({ tauriPage: page }) => {
    await openHome(page);

    const backBtn = page.getByTitle('Back');
    const fwdBtn = page.getByTitle('Forward');

    await expect(backBtn).toBeDisabled();
    await expect(fwdBtn).toBeDisabled();
  });

  test('forward button works after home -> page -> back', async ({ tauriPage: page }) => {
    await openHome(page);

    const input = page.locator('input[placeholder="Search or enter address"]');
    const backBtn = page.getByTitle('Back');
    const fwdBtn = page.getByTitle('Forward');

    // Navigate to a page
    await input.click();
    await input.fill('https://example.com');
    await input.press('Enter');

    // Back should be enabled, forward disabled
    await expect(backBtn).toBeEnabled();
    await expect(fwdBtn).toBeDisabled();

    // Go back to launcher
    await backBtn.click();
    await expect(page.getByRole('heading', { name: 'Suggestions' })).toBeVisible();

    // Forward should now be enabled
    await expect(fwdBtn).toBeEnabled();

    // Go forward — should navigate back to the page
    await fwdBtn.click();
    await expect(page.getByRole('heading', { name: 'Suggestions' })).not.toBeVisible();

    const navCalls = await getInvocationsFor(page, 'create_nip07_webview');
    expect(navCalls.length).toBeGreaterThanOrEqual(2); // initial + forward
  });

  test('address bar updates when navigating', async ({ tauriPage: page }) => {
    await openHome(page);

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('https://example.com');
    await input.press('Enter');

    // Ensure blur completes before checking display URL
    await input.blur();
    await expect(input).toHaveValue('example.com');
  });
});
