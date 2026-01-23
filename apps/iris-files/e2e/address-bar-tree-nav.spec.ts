/**
 * E2E test for address bar navigation to tree paths
 * Tests that pasting npub/treeName/path navigates to TreeRoute, not UserRoute
 */
import { test, expect } from './fixtures';
import { setupPageErrorHandler } from './test-utils.js';

test.describe('Address Bar Tree Navigation', () => {
  test('navigates to tree path when typing npub/treeName/path in address bar', async ({ page }) => {
    setupPageErrorHandler(page);
    // Use iris.html which has the address bar (main toolbar)
    await page.goto('/iris.html');
    // Wait for toolbar to be visible (IrisApp doesn't have header, it has a toolbar)
    await page.waitForSelector('input[placeholder="Search or enter address"]', { timeout: 30000 });

    // Use a test npub - any valid npub works for testing route parsing
    const npub = 'npub1wj6a4ex6hsp7rq4g3h9fzqwezt9f0478vnku9wzzkl25w2uudnds4z3upt';

    // Now test the address bar navigation
    // This is the exact pattern from the bug report: npub/treeName/nested/path
    const addressInput = page.locator('input[placeholder="Search or enter address"]');
    await addressInput.click();

    // Clear and type the full path (simulating paste)
    const testPath = `${npub}/public/test/nested/file.txt`;
    await addressInput.fill(testPath);
    await page.keyboard.press('Enter');

    // Wait for navigation
    await page.waitForURL(/public\/test\/nested\/file\.txt/, { timeout: 10000 });

    // The URL hash should include the full path
    expect(page.url()).toContain('public/test/nested/file.txt');

    // TreeRoute is rendering (shows "Loading..." since the tree doesn't exist)
    // This confirms the IrisRouter fix is working - it's rendering TreeRoute, not ProfileView

    // Wait for the loading indicator to appear (TreeRoute shows this while loading tree data)
    const loadingIndicator = page.locator('text=Loading...');
    await expect(loadingIndicator).toBeVisible({ timeout: 10000 });

    // Verify the route was parsed correctly by checking the routeStore
    const routeState = await page.evaluate(async () => {
      const routeStore = await import('/src/stores');
      let routeValue: any = null;
      const unsub = routeStore.routeStore.subscribe((v: any) => { routeValue = v; });
      unsub();
      return {
        hash: window.location.hash,
        routeValue,
      };
    });

    console.log('[test] Route state:', JSON.stringify(routeState, null, 2));

    // The routeStore should have treeName set (TreeRoute, not ProfileView)
    // This is the key assertion - if ProfileView was rendered, treeName would be null
    expect(routeState.routeValue.treeName).toBe('public');
    expect(routeState.routeValue.path).toEqual(['test', 'nested', 'file.txt']);
  });

  test('matchRoute correctly handles npub/treeName/path pattern', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/iris.html');
    await page.waitForSelector('input[placeholder="Search or enter address"]', { timeout: 30000 });

    // Wait for initial loading to complete
    await page.waitForLoadState('networkidle');

    // Test the matchRoute function directly
    const results = await page.evaluate(async () => {
      const { matchRoute } = await import('/src/lib/router.svelte');

      const testPath = '/npub1wj6a4ex6hsp7rq4g3h9fzqwezt9f0478vnku9wzzkl25w2uudnds4z3upt/public/jumble/dist/index.html';

      // Test all relevant patterns in order
      const patterns = [
        { pattern: '/', name: 'home' },
        { pattern: '/:npub/profile', name: 'profile-explicit' },
        { pattern: '/:npub/:treeName/*', name: 'tree-wildcard' },
        { pattern: '/:npub/:treeName', name: 'tree-exact' },
        { pattern: '/:id/*', name: 'user-wildcard' },
        { pattern: '/:id', name: 'user-exact' },
      ];

      const results = patterns.map(({ pattern, name }) => ({
        name,
        pattern,
        ...matchRoute(pattern, testPath),
      }));

      return results;
    });

    console.log('[test] matchRoute results:', JSON.stringify(results, null, 2));

    // Find first match
    const firstMatch = results.find(r => r.matched);
    expect(firstMatch).toBeDefined();
    expect(firstMatch!.name).toBe('tree-wildcard');
    expect(firstMatch!.params.treeName).toBe('public');
    expect(firstMatch!.params.wild).toBe('jumble/dist/index.html');
  });
});
