import { test, expect } from './fixtures';
import { setupPageErrorHandler, navigateToPublicFolder, goToTreeList } from './test-utils.js';

async function createAndEnterTree(page: any, name: string) {
  await goToTreeList(page);
  await expect(page.getByRole('button', { name: 'New Folder' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'New Folder' }).click();
  await page.locator('input[placeholder="Folder name..."]').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Empty directory')).toBeVisible({ timeout: 10000 });
}

async function createFile(page: any, name: string, content: string = '') {
  await page.getByRole('button', { name: /File/ }).first().click();
  await page.locator('input[placeholder="File name..."]').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  const doneButton = page.getByRole('button', { name: 'Done' });
  await expect(doneButton).toBeVisible({ timeout: 5000 });
  if (content) {
    await page.locator('textarea').fill(content);
    const saveButton = page.getByRole('button', { name: /Save|Saved|Saving/ }).first();
    if (await saveButton.isEnabled().catch(() => false)) {
      await saveButton.click();
    }
    await expect(saveButton).toBeDisabled({ timeout: 10000 });
  }
  await doneButton.click();
  await expect(page.locator('textarea')).not.toBeVisible({ timeout: 10000 });
}

test.describe('Anchor Links', () => {
  test.setTimeout(120000);

  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await navigateToPublicFolder(page);
  });

  test.describe('Markdown Heading Anchors', () => {
    test('headings should have id attributes for anchor linking', async ({ page }) => {
      await createAndEnterTree(page, 'anchor-md-test');
      await createFile(page, 'README.md', '# First Heading\n\nSome text.\n\n## Second Heading\n\nMore text.\n\n### Third-Level Heading\n\nEven more.');

      await goToTreeList(page);
      await page.locator('a:has-text("anchor-md-test")').first().click();
      await expect(page.locator('.i-lucide-book-open')).toBeVisible({ timeout: 30000 });

      // Headings should have slugified id attributes
      await expect(page.locator('#first-heading')).toBeVisible();
      await expect(page.locator('#second-heading')).toBeVisible();
      await expect(page.locator('#third-level-heading')).toBeVisible();
    });

    test('heading anchors should have clickable link icons', async ({ page }) => {
      await createAndEnterTree(page, 'anchor-link-test');
      await createFile(page, 'README.md', '# Test Heading\n\nContent here.');

      await goToTreeList(page);
      await page.locator('a:has-text("anchor-link-test")').first().click();
      await expect(page.locator('.i-lucide-book-open')).toBeVisible({ timeout: 30000 });

      // Heading should have an anchor link
      const heading = page.locator('#test-heading');
      await expect(heading).toBeVisible();
      const anchorLink = heading.locator('a.heading-anchor');
      await expect(anchorLink).toBeVisible();
    });

    test('clicking heading anchor should update URL hash', async ({ page }) => {
      await createAndEnterTree(page, 'anchor-url-test');
      await createFile(page, 'README.md', '# My Section\n\nText.');

      await goToTreeList(page);
      await page.locator('a:has-text("anchor-url-test")').first().click();
      await expect(page.locator('#my-section')).toBeVisible({ timeout: 30000 });

      // Hover to reveal anchor, then click
      await page.locator('#my-section').hover();
      await page.locator('#my-section a.heading-anchor').click({ force: true });
      await expect(page).toHaveURL(/[?&]anchor=my-section/);
    });
  });

  test.describe('Source Code Line Links', () => {
    test('code viewer should display line numbers', async ({ page }) => {
      await createAndEnterTree(page, 'line-num-test');
      await createFile(page, 'test.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;');

      await page.locator('a:has-text("test.ts")').first().click();
      await expect(page.locator('pre')).toBeVisible({ timeout: 10000 });

      // Line numbers should be visible
      await expect(page.locator('[data-line="1"]')).toBeVisible();
      await expect(page.locator('[data-line="5"]')).toBeVisible();
    });

    test('clicking line number should update URL with line reference', async ({ page }) => {
      await createAndEnterTree(page, 'line-click-test');
      await createFile(page, 'code.js', 'line1\nline2\nline3\nline4\nline5');

      await page.locator('a:has-text("code.js")').first().click();
      await expect(page.locator('pre')).toBeVisible({ timeout: 10000 });

      // Click line 3
      await page.locator('[data-line="3"] .line-number').click();
      await expect(page).toHaveURL(/[?&]L=3/);
    });

    test('URL with line hash should highlight that line', async ({ page }) => {
      await createAndEnterTree(page, 'line-highlight-test');
      await createFile(page, 'src.py', 'a = 1\nb = 2\nc = 3\nd = 4\ne = 5');

      await page.locator('a:has-text("src.py")').first().click();
      await expect(page.locator('[data-line="3"]')).toBeVisible({ timeout: 10000 });

      // Click line 3 to add query param, then verify highlight
      await page.locator('[data-line="3"] .line-number').click();
      await expect(page).toHaveURL(/[?&]L=3/);
      await expect(page.locator('[data-line="3"]')).toHaveClass(/line-highlighted/);
    });

    test('URL with line range should highlight multiple lines', async ({ page }) => {
      await createAndEnterTree(page, 'line-range-test');
      await createFile(page, 'range.rs', 'fn main() {\n    let x = 1;\n    let y = 2;\n    let z = 3;\n    println!("{}", x + y + z);\n}');

      await page.locator('a:has-text("range.rs")').first().click();
      await expect(page.locator('[data-line="2"]')).toBeVisible({ timeout: 10000 });

      // Click line 2, then shift-click line 4 to select range
      await page.locator('[data-line="2"] .line-number').click();
      await expect(page).toHaveURL(/[?&]L=2($|&)/);

      // Wait for component to stabilize before shift-click
      await expect(page.locator('[data-line="4"] .line-number')).toBeVisible();
      await page.locator('[data-line="4"] .line-number').click({ modifiers: ['Shift'] });
      await expect(page).toHaveURL(/[?&]L=2-4/);

      // Lines 2-4 should be highlighted
      await expect(page.locator('[data-line="2"]')).toHaveClass(/line-highlighted/);
      await expect(page.locator('[data-line="3"]')).toHaveClass(/line-highlighted/);
      await expect(page.locator('[data-line="4"]')).toHaveClass(/line-highlighted/);
      // Line 1 and 5 should not be highlighted
      await expect(page.locator('[data-line="1"]')).not.toHaveClass(/line-highlighted/);
      await expect(page.locator('[data-line="5"]')).not.toHaveClass(/line-highlighted/);
    });

    test('shift-click should select line range', async ({ page }) => {
      await createAndEnterTree(page, 'shift-click-test');
      await createFile(page, 'multi.go', 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("hi")\n}');

      await page.locator('a:has-text("multi.go")').first().click();
      await expect(page.locator('[data-line="3"]')).toBeVisible({ timeout: 10000 });

      // Click line 3
      await page.locator('[data-line="3"] .line-number').click();
      await expect(page).toHaveURL(/[?&]L=3($|&)/);

      // Wait for DOM to stabilize after hash change, then shift-click line 5
      await expect(page.locator('[data-line="5"] .line-number')).toBeVisible();
      await page.locator('[data-line="5"] .line-number').click({ modifiers: ['Shift'] });

      await expect(page).toHaveURL(/[?&]L=3-5/);
    });

    test('opening URL with ?L= should scroll to and highlight that line', async ({ page }) => {
      await createAndEnterTree(page, 'scroll-line-test');
      // Generate enough lines to require scrolling
      const lines = Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
      await createFile(page, 'long.ts', lines);

      // Click on file first to get the URL pattern
      await page.locator('a:has-text("long.ts")').first().click();
      await expect(page.locator('[data-line="1"]')).toBeVisible({ timeout: 10000 });

      // Now navigate to the same file with ?L=80
      const currentHash = await page.evaluate(() => window.location.hash);
      const baseHash = currentHash.replace(/\?.*$/, '');
      await page.evaluate((hash) => { window.location.hash = hash; }, `${baseHash}?L=80`);

      // Line 80 should be highlighted and scrolled into viewport
      await expect(page.locator('[data-line="80"]')).toHaveClass(/line-highlighted/, { timeout: 10000 });
      const isInViewport = await page.locator('[data-line="80"]').evaluate((el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      });
      expect(isInViewport).toBe(true);
    });
  });
});
