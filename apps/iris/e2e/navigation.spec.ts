import { test, expect, emitTauriEvent, getInvocationsFor, setupPageErrorHandler, gotoHome } from './fixtures';

async function openHome(page: import('@playwright/test').Page) {
  setupPageErrorHandler(page);
  await gotoHome(page);
}

test.describe('Navigation', () => {
  test('toolbar does not depend on the JS drag fallback', async ({ tauriPage: page }) => {
    await openHome(page);
    await expect(page.locator('input[placeholder="Search or enter address"]')).toBeVisible();

    const toolbar = page.locator('div[style="padding-left: 88px;"]');
    await toolbar.click({ position: { x: 20, y: 20 }, force: true });

    const dragCalls = await getInvocationsFor(page, 'plugin:window|start_dragging');
    expect(dragCalls).toHaveLength(0);
  });

  test('toolbar controls do not trigger the JS drag fallback', async ({ tauriPage: page }) => {
    await openHome(page);

    await page.locator('input[placeholder="Search or enter address"]').click();
    await page.getByTitle('Home').click();
    await page.getByTitle('Settings').click();

    const dragCalls = await getInvocationsFor(page, 'plugin:window|start_dragging');
    expect(dragCalls).toHaveLength(0);
  });

  test('toolbar marks only non-interactive header regions as draggable', async ({ tauriPage: page }) => {
    await openHome(page);
    await expect(page.locator('input[placeholder="Search or enter address"]')).toBeVisible();

    const dragRegions = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[placeholder="Search or enter address"]');
      const backButton = document.querySelector<HTMLButtonElement>('button[title="Back"]');
      const settingsButton = document.querySelector<HTMLButtonElement>('button[title="Settings"]');

      if (!input || !backButton || !settingsButton) {
        throw new Error('toolbar controls not found');
      }

      const addressBar = input.parentElement;
      const centerRegion = addressBar?.parentElement;
      const navRegion = backButton.parentElement;
      const toolbar = navRegion?.parentElement;
      const searchIcon = addressBar?.querySelector('.i-lucide-search');

      return {
        toolbar: toolbar?.getAttribute('data-tauri-drag-region'),
        navRegion: navRegion?.getAttribute('data-tauri-drag-region'),
        centerRegion: centerRegion?.getAttribute('data-tauri-drag-region'),
        addressBar: addressBar?.getAttribute('data-tauri-drag-region'),
        searchIcon: searchIcon?.getAttribute('data-tauri-drag-region'),
        backButton: backButton.getAttribute('data-tauri-drag-region'),
        settingsButton: settingsButton.getAttribute('data-tauri-drag-region'),
        input: input.getAttribute('data-tauri-drag-region'),
      };
    });

    expect(dragRegions.toolbar).not.toBeNull();
    expect(dragRegions.navRegion).not.toBeNull();
    expect(dragRegions.centerRegion).not.toBeNull();
    expect(dragRegions.addressBar).toBe('false');
    expect(dragRegions.searchIcon).toBe('false');
    expect(dragRegions.backButton).toBe('false');
    expect(dragRegions.settingsButton).toBe('false');
    expect(dragRegions.input).toBe('false');
  });

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

    // Blur via a real click outside the field to avoid worker timing flakiness.
    await page.locator('main').click({ position: { x: 20, y: 20 } });
    await expect(input).toHaveValue('example.com');
  });

  test('refresh does not create synthetic webview history', async ({ tauriPage: page }) => {
    await openHome(page);

    const input = page.locator('input[placeholder="Search or enter address"]');
    await input.click();
    await input.fill('https://example.com');
    await input.press('Enter');

    await emitTauriEvent(page, 'child-webview-location', {
      label: 'content',
      url: 'https://example.com',
      source: 'load',
    });
    await emitTauriEvent(page, 'child-webview-page-load', {
      label: 'content',
      url: 'https://example.com',
      event: 'finished',
    });

    await expect(page.getByTitle('Refresh')).toBeVisible();
    await page.getByTitle('Refresh').click();
    const reloadCalls = await getInvocationsFor(page, 'reload_webview');
    expect(reloadCalls).toHaveLength(1);

    await emitTauriEvent(page, 'child-webview-location', {
      label: 'content',
      url: 'https://example.com',
      source: 'load',
    });
    await emitTauriEvent(page, 'child-webview-page-load', {
      label: 'content',
      url: 'https://example.com',
      event: 'finished',
    });

    await page.getByTitle('Back').click();

    await expect(page.getByRole('heading', { name: 'Suggestions' })).toBeVisible();
    const historyCalls = await getInvocationsFor(page, 'webview_history');
    expect(historyCalls).toHaveLength(0);
  });
});
