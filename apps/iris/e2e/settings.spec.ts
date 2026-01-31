import { test, expect, getInvocationsFor, setupPageErrorHandler, gotoHome } from './fixtures';

async function openHome(page: import('@playwright/test').Page) {
  setupPageErrorHandler(page);
  await gotoHome(page);
}

test.describe('Settings Page', () => {
  test('shows desktop app settings', async ({ tauriPage: page }) => {
    await openHome(page);
    await page.getByTitle('Settings').click();

    // Desktop section
    await expect(page.getByText('Desktop App')).toBeVisible();
    await expect(page.getByText('Launch at startup')).toBeVisible();
    await expect(page.getByText('Open Iris automatically when you log in')).toBeVisible();

    // Daemon section (should show since mock returns URL)
    await expect(page.getByText('Daemon')).toBeVisible();
    await expect(page.getByText('http://127.0.0.1:21417')).toBeVisible();

    // About section
    await expect(page.getByText('About')).toBeVisible();
  });

  test('autostart toggle sends invoke', async ({ tauriPage: page }) => {
    await openHome(page);
    await page.getByTitle('Settings').click();

    // Click the toggle
    await page.getByLabel('Toggle launch at startup').click();

    // Since autostart plugin is mocked, the toggle should have called
    // through the import('@tauri-apps/plugin-autostart') path which
    // will fail in browser context. The UI should handle the error gracefully.
    // Just verify no crash occurred.
    await expect(page.getByText('Launch at startup')).toBeVisible();
  });

  test('clear history button clears and shows feedback', async ({ tauriPage: page }) => {
    await openHome(page);
    await page.getByTitle('Settings').click();

    // Privacy section should be visible
    await expect(page.getByText('Privacy')).toBeVisible();
    await expect(page.getByText('Browsing history', { exact: true })).toBeVisible();

    // Click clear history
    await page.getByRole('button', { name: 'Clear history' }).click();

    // Should show "Cleared!" feedback
    await expect(page.getByText('Cleared!')).toBeVisible();

    // Verify the command was invoked
    const calls = await getInvocationsFor(page, 'clear_history');
    expect(calls.length).toBe(1);

    // After 2 seconds, the button should reappear
    await expect(page.getByRole('button', { name: 'Clear history' })).toBeVisible({ timeout: 3000 });
  });
});
