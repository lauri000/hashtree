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

  test('slide image is not a hyperlink target', async ({ page }) => {
    await expect(page.locator('a:has(img[alt="Iris Files"])')).toHaveCount(0);
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

  test('dragging carousel navigates to next slide', async ({ page }) => {
    await expect(page.getByText('Git repos, file manager')).toBeVisible();

    const carousel = page.getByRole('region', { name: 'Use case carousel' });
    await carousel.focus();

    const viewport = carousel.locator('.overflow-hidden').first();
    const box = await viewport.boundingBox();

    if (!box) {
      throw new Error('Carousel viewport was not visible');
    }

    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5, { steps: 12 });
    await page.mouse.up();

    await expect(page.getByText('Collaborative documents')).toBeVisible({ timeout: 1500 });
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
    await expect(page.getByText('Collaborative documents')).toBeVisible({ timeout: 12000 });
  });
});
