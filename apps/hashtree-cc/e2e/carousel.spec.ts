import { test, expect } from '@playwright/test';

test.describe('Use case carousel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByText('For Developers').click();
    await expect(page.getByText('Built on Hashtree')).toBeVisible();
  });

  test('shows first slide by default', async ({ page }) => {
    await expect(page.getByAltText('Iris Files')).toBeVisible();
    await expect(page.getByText('Git repos, file manager')).toBeVisible();
  });

  test('next button advances slide', async ({ page }) => {
    await expect(page.getByText('Git repos, file manager')).toBeVisible();

    await page.getByLabel('Next').click();
    await expect(page.getByText('Collaborative documents')).toBeVisible();
    await expect(page.getByText('Git repos, file manager')).not.toBeVisible();
  });

  test('prev button goes back', async ({ page }) => {
    await page.getByLabel('Next').click();
    await expect(page.getByText('Collaborative documents')).toBeVisible();

    await page.getByLabel('Previous').click();
    await expect(page.getByText('Git repos, file manager')).toBeVisible();
  });

  test('dot navigation works', async ({ page }) => {
    await page.getByLabel('Slide 3').click();
    await expect(page.getByText('Video streaming and playlists')).toBeVisible();

    await page.getByLabel('Slide 1').click();
    await expect(page.getByText('Git repos, file manager')).toBeVisible();
  });

  test('arrow keys navigate when carousel focused', async ({ page }) => {
    const carousel = page.getByRole('region', { name: 'Use case carousel' });
    await carousel.click();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByText('Collaborative documents')).toBeVisible();

    await page.keyboard.press('ArrowLeft');
    await expect(page.getByText('Git repos, file manager')).toBeVisible();
  });

  test('auto-advances after timeout', async ({ page }) => {
    await expect(page.getByText('Git repos, file manager')).toBeVisible();
    // wait for auto-advance (5s interval)
    await expect(page.getByText('Collaborative documents')).toBeVisible({ timeout: 7000 });
  });
});
