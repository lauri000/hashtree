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

  test('network tab shows mesh traffic and bluetooth peers from daemon status', async ({ tauriPage: page }) => {
    await page.route('http://127.0.0.1:21417/api/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'running',
          mesh: {
            enabled: true,
            total_peers: 2,
            connected: 2,
            with_data_channel: 2,
            bytes_sent: 15360,
            bytes_received: 28672,
            transport_counts: {
              webrtc: 1,
              bluetooth: 1,
            },
            peers: [
              {
                id: 'peer-a',
                peer_id: 'peer-a',
                pubkey: 'f'.repeat(64),
                state: 'Connected',
                pool: 'Follows',
                transport: 'bluetooth',
                signal_paths: ['bluetooth'],
                connected: true,
                has_data_channel: true,
                bytes_sent: 4096,
                bytes_received: 8192,
              },
              {
                id: 'peer-b',
                peer_id: 'peer-b',
                pubkey: 'e'.repeat(64),
                state: 'Connected',
                pool: 'Other',
                transport: 'webrtc',
                signal_paths: ['relay'],
                connected: true,
                has_data_channel: true,
                bytes_sent: 11264,
                bytes_received: 20480,
              },
            ],
          },
          webrtc: {
            enabled: true,
          },
          upstream: {
            blossom_servers: 2,
          },
        }),
      });
    });

    await openHome(page);
    await page.getByTitle('Settings').click();
    await page.getByRole('button', { name: 'Network' }).click();

    await expect(page.getByRole('heading', { name: 'Mesh' })).toBeVisible();
    await expect(page.getByText('2 connected')).toBeVisible();
    await expect(page.getByText('1 bluetooth')).toBeVisible();
    await expect(page.getByText('1 webrtc')).toBeVisible();
    await expect(page.getByText('Upload', { exact: true })).toBeVisible();
    await expect(page.getByText('Download', { exact: true })).toBeVisible();
    await expect(page.getByText('Recent Throughput')).toBeVisible();
    await expect(page.getByText('Active Peers')).toBeVisible();
    await expect(page.getByText('relay', { exact: true })).toBeVisible();
    await expect(page.getByText('blossom servers')).toBeVisible();
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
