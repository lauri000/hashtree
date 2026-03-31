import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { setupPageErrorHandler, navigateToPublicFolder, goToTreeList } from './test-utils.js';

test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
});

// Helper to create tree and navigate into it
async function createAndEnterTree(page: Page, name: string) {
  await goToTreeList(page);
  await expect(page.getByRole('button', { name: 'New Folder' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'New Folder' }).click();
  await page.locator('input[placeholder="Folder name..."]').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Empty directory')).toBeVisible({ timeout: 10000 });
}

// Helper to create a file
async function createFile(page: Page, name: string, content: string = '') {
  await page.getByRole('button', { name: /File/ }).first().click();
  await page.locator('input[placeholder="File name..."]').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  const doneButton = page.getByRole('button', { name: 'Done' });
  const editorTextarea = page.locator('textarea').last();
  await expect(doneButton).toBeVisible({ timeout: 5000 });
  await expect(editorTextarea).toBeVisible({ timeout: 5000 });
  if (content) {
    await editorTextarea.fill(content);
    const saveButton = page.getByRole('button', { name: /Save|Saved|Saving/ }).first();
    if (await saveButton.isEnabled().catch(() => false)) {
      await saveButton.click();
    }
    await expect(saveButton).toBeDisabled({ timeout: 10000 });
  }
  await doneButton.click();
  await expect(doneButton).not.toBeVisible({ timeout: 10000 });
  await expect(editorTextarea).not.toBeVisible({ timeout: 10000 });
}

test.describe('README Panel', () => {
  test.setTimeout(120000);

  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');

    // Clear storage for fresh state
    await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
      localStorage.clear();
      sessionStorage.clear();
    });

    await page.reload();
    // Page ready - navigateToPublicFolder handles waiting
    await navigateToPublicFolder(page);
  });

  test('should display README.md content in directory view', async ({ page }) => {
    // Create tree with README
    await createAndEnterTree(page, 'readme-test');
    await createFile(page, 'README.md', '# Hello World\n\nThis is a test readme.');

    // Navigate back to tree to see the readme panel
    await goToTreeList(page);
    await page.locator('a:has-text("readme-test")').first().click();

    // Check that README panel is visible with rendered content
    // The panel has a header with book-open icon and "README.md" text
    await expect(page.locator('.i-lucide-book-open')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('text=Hello World')).toBeVisible();
    await expect(page.locator('text=This is a test readme')).toBeVisible();
  });

  test('should have edit button for README when user can edit', async ({ page }) => {
    // Create tree with README
    await createAndEnterTree(page, 'readme-edit-test');
    await createFile(page, 'README.md', '# Editable');

    // Navigate back to tree
    await goToTreeList(page);
    await page.locator('a:has-text("readme-edit-test")').first().click();

    // Check edit button exists in README panel
    await expect(page.locator('.i-lucide-book-open')).toBeVisible({ timeout: 30000 });
    // Edit button should be in the README panel header
    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  });

  test('should navigate relative links within the tree', async ({ page }) => {
    // Create tree with a subdirectory and README linking to it
    await createAndEnterTree(page, 'link-test');

    // Create a subdir with its own README
    await page.getByRole('button', { name: 'Folder' }).click();
    await page.locator('input[placeholder="Folder name..."]').fill('subdir');
    await page.getByRole('button', { name: 'Create' }).click();
    const subdirLink = page.locator('a:has-text("subdir")').first();
    await expect(subdirLink).toBeVisible({ timeout: 10000 });
    await subdirLink.click();
    await expect(page.getByRole('button', { name: /File/ }).first()).toBeVisible({ timeout: 10000 });

    // Create README in subdir
    await createFile(page, 'README.md', '# Subdir Docs\n\nThis is the subdir readme.');

    // Go back to parent
    await page.getByRole('link', { name: '..' }).click();
    await expect(page.getByRole('button', { name: /File/ }).first()).toBeVisible({ timeout: 10000 });

    // Create root README with relative link
    await createFile(page, 'README.md', '# Main\n\nSee [subdir docs](subdir/README.md) for more.');

    // Navigate back to tree root to see the readme panel
    await goToTreeList(page);
    await page.locator('a:has-text("link-test")').first().click();
    await expect(page.locator('.i-lucide-book-open')).toBeVisible({ timeout: 30000 });

    // Click the relative link in the README
    await page.locator('.prose a:has-text("subdir docs")').click();

    // Should navigate to the subdir README file
    await expect(page).toHaveURL(/#.*link-test.*subdir.*README\.md/);
  });

  test('should wrap long inline markdown tokens without horizontal overflow', async ({ page }) => {
    await createAndEnterTree(page, 'readme-wrap-test');
    await createFile(
      page,
      'README.md',
      `# Wrap Test

> \`htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/${'iris-client-'.repeat(18)}\`
`
    );

    await goToTreeList(page);
    await page.locator('a:has-text("readme-wrap-test")').first().click();

    await expect(page.locator('.i-lucide-book-open')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('text=Wrap Test')).toBeVisible();

    const wrapState = await page.locator('.markdown-content').first().evaluate((node) => {
      const container = node as HTMLElement;
      const code = container.querySelector('blockquote code') as HTMLElement | null;
      const containerRect = container.getBoundingClientRect();
      const codeRect = code?.getBoundingClientRect();
      return {
        hasOverflow: container.scrollWidth > container.clientWidth + 1,
        codeRight: codeRect?.right ?? 0,
        containerRight: containerRect.right,
      };
    });

    expect(wrapState.hasOverflow).toBe(false);
    expect(wrapState.codeRight).toBeLessThanOrEqual(wrapState.containerRight + 1);
  });

  test('should copy fenced command blocks from README.md', async ({ page }) => {
    const installCommand = 'curl -fsSL https://upload.iris.to/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/releases%2Fhashtree/latest/install.sh | sh';

    await createAndEnterTree(page, 'readme-copy-test');
    await createFile(
      page,
      'README.md',
      `# Install

\`\`\`bash
${installCommand}
\`\`\`
`
    );

    await goToTreeList(page);
    await page.locator('a:has-text("readme-copy-test")').first().click();

    await expect(page.locator('.i-lucide-book-open')).toBeVisible({ timeout: 30000 });
    const copyButton = page.locator('.markdown-content').first().getByRole('button', { name: 'Copy code' });
    await expect(copyButton).toBeVisible();

    await copyButton.click();

    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(installCommand);
    await expect(copyButton).toContainText('Copied');
  });
});
