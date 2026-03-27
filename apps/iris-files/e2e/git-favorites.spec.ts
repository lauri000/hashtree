import { test, expect } from './fixtures';
import {
  createRepositoryInCurrentDirectory,
  ensureLoggedIn,
  flushPendingPublishes,
  gotoGitApp,
  setupPageErrorHandler,
  waitForRelayConnected,
} from './test-utils.js';

test.describe('Git favorites', () => {
  test('liked repositories appear on home and profile', async ({ page, browser }) => {
    setupPageErrorHandler(page);

    await gotoGitApp(page);
    await ensureLoggedIn(page);
    await waitForRelayConnected(page);

    const owner = await page.evaluate(() => ({
      npub: (window as { __nostrStore?: { getState?: () => { npub?: string } } }).__nostrStore?.getState?.().npub ?? null,
    }));
    expect(owner.npub).toBeTruthy();

    const repoName = `liked-repo-${Date.now()}`;
    await createRepositoryInCurrentDirectory(page, repoName);
    await flushPendingPublishes(page);

    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    setupPageErrorHandler(viewerPage);

    await gotoGitApp(viewerPage);
    await ensureLoggedIn(viewerPage);
    await waitForRelayConnected(viewerPage);

    const viewer = await viewerPage.evaluate(() => ({
      npub: (window as { __nostrStore?: { getState?: () => { npub?: string } } }).__nostrStore?.getState?.().npub ?? null,
    }));
    expect(viewer.npub).toBeTruthy();
    expect(viewer.npub).not.toBe(owner.npub);

    await viewerPage.goto(`/git.html#/${owner.npub}/${repoName}`);

    const favoriteButton = viewerPage.getByRole('button', { name: /Like|Liked/ }).first();
    await expect(favoriteButton).toBeVisible({ timeout: 15000 });

    if (!(await favoriteButton.innerText()).includes('Liked')) {
      await favoriteButton.click();
    }

    await expect(favoriteButton).toContainText('Liked', { timeout: 15000 });
    await expect(favoriteButton).toContainText('1', { timeout: 15000 });

    await gotoGitApp(viewerPage);

    const homeFavoritesHeading = viewerPage.getByRole('heading', { name: 'Liked Repositories' }).first();
    await expect(homeFavoritesHeading).toBeVisible({ timeout: 15000 });
    await expect(viewerPage.getByRole('link', { name: new RegExp(repoName) }).first()).toBeVisible({ timeout: 15000 });

    await viewerPage.goto(`/git.html#/${viewer.npub}`);

    const profileFavoritesHeading = viewerPage.getByRole('heading', { name: 'Liked Repositories' }).first();
    await expect(profileFavoritesHeading).toBeVisible({ timeout: 15000 });
    await expect(viewerPage.getByRole('link', { name: new RegExp(repoName) }).first()).toBeVisible({ timeout: 15000 });

    await viewerContext.close();
  });
});
