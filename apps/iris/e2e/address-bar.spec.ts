import { test, expect, getInvocationsFor, setupPageErrorHandler, gotoHome } from './fixtures';

async function openHome(page: import('@playwright/test').Page) {
  setupPageErrorHandler(page);
  await gotoHome(page);
}

test.describe('Address Bar', () => {
  test('navigating via address bar creates webview', async ({ tauriPage: page }) => {
    await openHome(page);

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('https://example.com');
    await input.press('Enter');

    const calls = await getInvocationsFor(page, 'create_nip07_webview');
    expect(calls.length).toBe(1);
    expect(calls[0].args.url).toBe('https://example.com');
  });

  test('bare domain gets https prefix', async ({ tauriPage: page }) => {
    await openHome(page);

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('example.com');
    await input.press('Enter');

    const calls = await getInvocationsFor(page, 'create_nip07_webview');
    expect(calls.length).toBe(1);
    expect(calls[0].args.url).toBe('https://example.com');
  });

  test('htree URL uses create_htree_webview', async ({ tauriPage: page }) => {
    await openHome(page);

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
    await openHome(page);

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

  test('bare npub1 gets htree:// prefix', async ({ tauriPage: page }) => {
    await openHome(page);

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('npub1abc123def456/my-tree');
    await input.press('Enter');

    const calls = await getInvocationsFor(page, 'create_htree_webview');
    expect(calls.length).toBe(1);
    expect(calls[0].args.npub).toBe('npub1abc123def456');
    expect(calls[0].args.treename).toBe('my-tree');
  });

  test('bare nhash1 gets htree:// prefix', async ({ tauriPage: page }) => {
    await openHome(page);

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('nhash1abc123/Featured.jpg');
    await input.press('Enter');

    const calls = await getInvocationsFor(page, 'create_htree_webview');
    expect(calls.length).toBe(1);
    expect(calls[0].args.nhash).toBe('nhash1abc123');
    expect(calls[0].args.path).toBe('/Featured.jpg');
  });

  test('trailing slash stripped from display URL', async ({ tauriPage: page }) => {
    await openHome(page);

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('https://video.iris.to/');
    await input.press('Enter');

    // Ensure blur completes before checking
    await input.blur();
    await expect(input).toHaveValue('video.iris.to');
  });

  test('focus shows full URL, blur shows display URL', async ({ tauriPage: page }) => {
    await openHome(page);

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('https://video.iris.to/');
    await input.press('Enter');

    // Blurred: display URL without protocol/trailing slash
    await input.blur();
    await expect(input).toHaveValue('video.iris.to');

    // Focus: full URL
    await input.click();
    await expect(input).toHaveValue('https://video.iris.to/');

    // Blur again: display URL
    await page.getByTitle('Home').click();
  });

  test('empty address bar submit does nothing', async ({ tauriPage: page }) => {
    await openHome(page);

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

test.describe('Address Bar Autocomplete', () => {
  /** Navigate to a URL via the address bar, then go home. */
  async function visitAndGoHome(page: import('@playwright/test').Page, url: string) {
    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill(url);
    await input.press('Enter');
    // Go home so we're back on the launcher
    await page.getByTitle('Home').click();
  }

  test('navigating records history and dropdown shows it on focus', async ({ tauriPage: page }) => {
    await openHome(page);

    // Visit two sites
    await visitAndGoHome(page, 'https://video.iris.to/');
    await visitAndGoHome(page, 'https://example.com');

    // Focus the address bar — should show both visited URLs
    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();

    const dropdown = page.locator('[role="listbox"]');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.locator('[role="option"]')).toHaveCount(2);
    await expect(dropdown.getByText('video.iris.to').first()).toBeVisible();
    await expect(dropdown.getByText('example.com').first()).toBeVisible();
  });

  test('search filters history results', async ({ tauriPage: page }) => {
    await openHome(page);

    await visitAndGoHome(page, 'https://video.iris.to/');
    await visitAndGoHome(page, 'https://example.com');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('video');

    const dropdown = page.locator('[role="listbox"]');
    await expect(dropdown).toBeVisible();
    // Only the matching entry should appear
    await expect(dropdown.locator('[role="option"]')).toHaveCount(1);
    await expect(dropdown.getByText('video.iris.to').first()).toBeVisible();
  });

  test('arrow keys navigate items', async ({ tauriPage: page }) => {
    await openHome(page);

    await visitAndGoHome(page, 'https://a.com');
    await visitAndGoHome(page, 'https://b.com');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();

    const dropdown = page.locator('[role="listbox"]');
    await expect(dropdown).toBeVisible();

    // Press down to select first item
    await input.press('ArrowDown');
    const firstOption = dropdown.locator('[role="option"]').first();
    await expect(firstOption).toHaveAttribute('aria-selected', 'true');

    // Press down again to select second
    await input.press('ArrowDown');
    const secondOption = dropdown.locator('[role="option"]').nth(1);
    await expect(secondOption).toHaveAttribute('aria-selected', 'true');
  });

  test('escape closes dropdown', async ({ tauriPage: page }) => {
    await openHome(page);

    await visitAndGoHome(page, 'https://example.com');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();

    const dropdown = page.locator('[role="listbox"]');
    await expect(dropdown).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dropdown).not.toBeVisible();
  });

  test('clicking dropdown item navigates to that URL', async ({ tauriPage: page }) => {
    await openHome(page);

    await visitAndGoHome(page, 'https://video.iris.to/');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();

    const dropdown = page.locator('[role="listbox"]');
    await expect(dropdown).toBeVisible();

    // Click the history item
    await dropdown.locator('[role="option"]').first().click();

    // Should have navigated (second create call — first was the initial visit)
    const calls = await getInvocationsFor(page, 'create_nip07_webview');
    expect(calls.length).toBe(2);
    expect(calls[1].args.url).toBe('https://video.iris.to/');
  });

  test('X button deletes entry from dropdown', async ({ tauriPage: page }) => {
    await openHome(page);

    await visitAndGoHome(page, 'https://video.iris.to/');
    await visitAndGoHome(page, 'https://example.com');

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();

    const dropdown = page.locator('[role="listbox"]');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.locator('[role="option"]')).toHaveCount(2);

    // Delete the first entry
    await dropdown.locator('[role="option"]').first().getByTitle('Delete').click();

    await expect(dropdown.locator('[role="option"]')).toHaveCount(1);

    // Verify delete was invoked
    const calls = await getInvocationsFor(page, 'delete_history_entry');
    expect(calls.length).toBe(1);
  });

  test('opening dropdown adjusts webview bounds', async ({ tauriPage: page }) => {
    await openHome(page);

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('https://example.com');
    await input.press('Enter');

    const before = await getInvocationsFor(page, 'set_webview_bounds');

    await input.click();
    await expect(page.locator('[role="listbox"]')).toBeVisible();

    await expect.poll(async () => (await getInvocationsFor(page, 'set_webview_bounds')).length)
      .toBeGreaterThan(before.length);
  });
});
