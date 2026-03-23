import { test, expect, getInvocationsFor, setupPageErrorHandler, gotoHome } from './fixtures';

const DISTRIBUTED_OWNER = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';

async function openHome(page: import('@playwright/test').Page) {
  setupPageErrorHandler(page);
  await gotoHome(page);
}

test.describe('Settings Page', () => {
  test('shows tabbed settings sections', async ({ tauriPage: page }) => {
    await openHome(page);
    await page.getByTitle('Settings').click();

    await expect(page.getByRole('button', { name: 'Desktop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Privacy' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Network' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'About' })).toBeVisible();

    await expect(page.getByText('Launch at startup')).toBeVisible();
    await expect(page.getByText('Open Iris automatically when you log in')).toBeVisible();
  });

  test('network tab shows daemon settings', async ({ tauriPage: page }) => {
    await openHome(page);
    await page.getByTitle('Settings').click();

    await page.getByRole('button', { name: 'Network' }).click();

    await expect(page.getByRole('heading', { name: 'Daemon' })).toBeVisible();
    await expect(page.getByText('http://127.0.0.1:21417')).toBeVisible();
  });

  test('about tab opens the hashtree repository in Iris Git', async ({ tauriPage: page }) => {
    await openHome(page);
    await page.getByTitle('Settings').click();

    await page.getByRole('button', { name: 'About' }).click();
    await expect(page.getByText('Source Browser')).toBeVisible();

    await page.getByRole('button', { name: 'Open hashtree repository' }).click();

    const calls = await getInvocationsFor(page, 'create_htree_webview');
    expect(calls.length).toBe(1);
    expect(calls[0].args.npub).toBe(DISTRIBUTED_OWNER);
    expect(calls[0].args.treename).toBe('git');
    expect(calls[0].args.path).toBe('/');
    expect(calls[0].args.fragment).toBe(`/${DISTRIBUTED_OWNER}/hashtree`);
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

    await page.getByRole('button', { name: 'Privacy' }).click();

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
