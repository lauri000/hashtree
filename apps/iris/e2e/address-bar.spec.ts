import { test, expect, getInvocationsFor } from './fixtures';

test.describe('Address Bar', () => {
  test('navigating via address bar creates webview', async ({ tauriPage: page }) => {
    await page.goto('/');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('https://example.com');
    await input.press('Enter');

    const calls = await getInvocationsFor(page, 'create_nip07_webview');
    expect(calls.length).toBe(1);
    expect(calls[0].args.url).toBe('https://example.com');
  });

  test('bare domain gets https prefix', async ({ tauriPage: page }) => {
    await page.goto('/');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('example.com');
    await input.press('Enter');

    const calls = await getInvocationsFor(page, 'create_nip07_webview');
    expect(calls.length).toBe(1);
    expect(calls[0].args.url).toBe('https://example.com');
  });

  test('htree URL uses create_htree_webview', async ({ tauriPage: page }) => {
    await page.goto('/');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('htree://npub1abc123def456/my-tree');
    await input.press('Enter');

    const calls = await getInvocationsFor(page, 'create_htree_webview');
    expect(calls.length).toBe(1);
    expect(calls[0].args.npub).toBe('npub1abc123def456');
    expect(calls[0].args.treename).toBe('my-tree');
    expect(calls[0].args.path).toBe('/');
  });

  test('htree URL with path parses correctly', async ({ tauriPage: page }) => {
    await page.goto('/');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('htree://npub1abc123def456/my-tree/some/path');
    await input.press('Enter');

    const calls = await getInvocationsFor(page, 'create_htree_webview');
    expect(calls.length).toBe(1);
    expect(calls[0].args.npub).toBe('npub1abc123def456');
    expect(calls[0].args.treename).toBe('my-tree');
    expect(calls[0].args.path).toBe('/some/path');
  });

  test('empty address bar submit does nothing', async ({ tauriPage: page }) => {
    await page.goto('/');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('');
    await input.press('Enter');

    // No webview creation
    const nip07 = await getInvocationsFor(page, 'create_nip07_webview');
    const htree = await getInvocationsFor(page, 'create_htree_webview');
    expect(nip07.length).toBe(0);
    expect(htree.length).toBe(0);

    // Launcher still visible
    await expect(page.getByRole('heading', { name: 'Suggestions' })).toBeVisible();
  });
});
