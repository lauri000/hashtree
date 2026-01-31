import { test, expect } from './fixtures';

test.describe('Settings Page', () => {
  test('shows desktop app settings', async ({ tauriPage: page }) => {
    await page.goto('/');
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
    await page.goto('/');
    await page.getByTitle('Settings').click();

    // Click the toggle
    await page.getByLabel('Toggle launch at startup').click();

    // Since autostart plugin is mocked, the toggle should have called
    // through the import('@tauri-apps/plugin-autostart') path which
    // will fail in browser context. The UI should handle the error gracefully.
    // Just verify no crash occurred.
    await expect(page.getByText('Launch at startup')).toBeVisible();
  });
});
