/**
 * E2E tests for Yjs document viewer
 *
 * Tests that directories with .yjs file are detected and rendered with Tiptap editor.
 * A Yjs document directory is identified by having a .yjs config file inside.
 */
import { test, expect } from './fixtures';
import { setupPageErrorHandler, waitForAppReady } from './test-utils.js';
import {
  createDocumentFromDocsHome,
  createManualYjsTreeFromDocsHome,
  createRegularTreeFromDocsHome,
  currentTreeHasEntry,
  setupDocsHome,
  waitForDocsEditor,
  waitForTreeRootChange,
} from './docs-test-utils.js';

test.describe('Yjs Document Viewer', () => {
  test.setTimeout(120000);

  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/docs.html#/');
    await waitForAppReady(page);

    // Clear storage for fresh state
    await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
      localStorage.clear();
      sessionStorage.clear();
    });

    await setupDocsHome(page);
  });

  test('New Document button creates folder with .yjs file', async ({ page }) => {
    await createDocumentFromDocsHome(page, 'notes');
    await expect.poll(() => currentTreeHasEntry(page, '.yjs'), { timeout: 30000 }).toBe(true);
  });

  test('non-document tree shows docs fallback message', async ({ page }) => {
    await createRegularTreeFromDocsHome(page, 'regular-folder');

    await expect(page.getByText('This is not a collaborative document')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("It doesn't contain a .yjs configuration file")).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('link', { name: 'Back to home' })).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.ProseMirror')).not.toBeVisible();
  });

  test('tree with manually created .yjs file shows Tiptap editor', async ({ page }) => {
    await createManualYjsTreeFromDocsHome(page, 'manual-doc');
    await waitForDocsEditor(page, 90000);
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 30000 });
  });

  test('typing in document editor works and auto-saves', async ({ page }) => {
    await createDocumentFromDocsHome(page, 'editable-doc');
    const editor = page.locator('.ProseMirror');
    await editor.click();

    // Type some text
    const rootBefore = await page.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
    await page.keyboard.type('Hello, this is a test document!');

    // Verify text appears in editor
    await expect(editor).toContainText('Hello, this is a test document!');

    // Wait for auto-save to update the tree root
    await waitForTreeRootChange(page, rootBefore, 60000);
  });

  test('clicking .yjs file directly shows fallback without errors', async ({ page }) => {
    // This test verifies that viewing a .yjs file directly doesn't throw
    // "undefined is not iterable" errors in Viewer.tsx

    // Track console errors
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', err => {
      consoleErrors.push(err.message);
    });

    await createDocumentFromDocsHome(page, 'test-doc');
    const docUrl = await page.evaluate(() => `${window.location.pathname}${window.location.hash}/.yjs`);
    await page.goto(docUrl);
    await waitForAppReady(page);
    await page.waitForTimeout(3000);

    await expect(page.getByText('Not a document directory')).toBeVisible({ timeout: 30000 });

    // Wait a bit more to ensure any async errors would have appeared
    await page.waitForTimeout(2000);

    // Filter for the specific error we're fixing
    const iterableErrors = consoleErrors.filter(e => e.includes('undefined is not iterable'));
    expect(iterableErrors).toHaveLength(0);
  });

  test('editor maintains focus after auto-save', async ({ page }) => {
    // This test verifies that typing in the editor doesn't lose focus
    // when the merkle root updates after auto-save

    // Create a new document
    await createDocumentFromDocsHome(page, 'focus-test');

    // Wait for editor to be visible
    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible({ timeout: 30000 });
    await editor.click();

    // Type initial content
    const rootBefore = await page.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
    await page.keyboard.type('First sentence.');

    // Wait for auto-save to complete
    await waitForTreeRootChange(page, rootBefore, 60000);

    // Verify editor still has focus (activeElement should be inside ProseMirror)
    const hasFocus = await page.evaluate(() => {
      const active = document.activeElement;
      const editor = document.querySelector('.ProseMirror');
      return editor?.contains(active) || active === editor;
    });
    expect(hasFocus).toBe(true);

    // Now type more content WITHOUT clicking the editor again
    // If focus is maintained, this text should appear after the first sentence
    const rootBeforeSecond = await page.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
    await page.keyboard.type(' Second sentence.');

    // Verify both sentences are in the editor
    await expect(editor).toContainText('First sentence. Second sentence.', { timeout: 30000 });

    // Wait for the second save to complete
    await waitForTreeRootChange(page, rootBeforeSecond, 60000);

    // Type a third sentence
    const rootBeforeThird = await page.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
    await page.keyboard.type(' Third sentence.');
    await waitForTreeRootChange(page, rootBeforeThird, 60000);

    // Verify all content is there
    await expect(editor).toContainText('First sentence. Second sentence. Third sentence.', { timeout: 30000 });
  });

  test('editor maintains focus during rapid typing and saves', async ({ page }) => {
    // This test verifies focus is maintained during rapid typing that triggers
    // multiple overlapping saves and merkle root updates

    // Create a new document
    await createDocumentFromDocsHome(page, 'rapid-focus-test');

    // Wait for editor to be visible
    const editor = page.locator('.ProseMirror');
    await expect(editor).toBeVisible({ timeout: 30000 });
    await editor.click();

    // Type content rapidly, triggering save debounces
    const rootBefore = await page.evaluate(() => (window as any).__getTreeRoot?.() ?? null);
    for (let i = 1; i <= 5; i++) {
      await page.keyboard.type(`Line ${i}. `);
      // Small delay to allow debounce to start but not complete
      await page.waitForTimeout(300);
    }

    // Wait for a save to complete
    await waitForTreeRootChange(page, rootBefore, 60000);

    // Now verify we can still type without clicking
    await page.keyboard.type('Final line.');

    // Verify all content is there
    await expect(editor).toContainText('Line 1. Line 2. Line 3. Line 4. Line 5. Final line.', { timeout: 30000 });
  });
});
