import { test, expect, type Page } from './fixtures';
import { setupPageErrorHandler, disableOthersPool, waitForAppReady, navigateToPublicFolder, gotoGitApp } from './test-utils.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const SUBDIR_NAME = 'subdir';
const SUBFILE_NAME = 'file.txt';
const README_NAME = 'README.md';
const GENERIC_SIDEBAR_SELECTOR = '[data-testid="file-list"][aria-label="File list"]';
const DIRECTORY_ACTIONS_ADD_FILES_SELECTOR = '[title="Add files"]';

async function createTempGitRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-file-bar-'));
  execSync('git init', { cwd: tmpDir });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir });
  execSync('git config user.name "Test User"', { cwd: tmpDir });

  await fs.mkdir(path.join(tmpDir, SUBDIR_NAME), { recursive: true });
  await fs.mkdir(path.join(tmpDir, '.hashtree'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, README_NAME), '# Git File Bar\n');
  await fs.writeFile(path.join(tmpDir, SUBDIR_NAME, SUBFILE_NAME), 'hello from subdir\n');
  await fs.writeFile(
    path.join(tmpDir, '.hashtree', 'project.toml'),
    [
      '[project]',
      'about = "Temporary repository for git view tests."',
      'homepage = "https://example.com/git-file-bar"',
      '',
    ].join('\n'),
  );

  execSync('git add .', { cwd: tmpDir });
  execSync('git commit -m "Initial commit"', { cwd: tmpDir });
  return tmpDir;
}

async function collectRepoFiles(rootDir: string, basePath = ''): Promise<Array<{ relativePath: string; content: number[] }>> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: Array<{ relativePath: string; content: number[] }> = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...await collectRepoFiles(fullPath, relativePath));
      continue;
    }

    if (entry.isFile()) {
      const content = await fs.readFile(fullPath);
      files.push({ relativePath, content: Array.from(content) });
    }
  }

  return files;
}

async function uploadGitRepo(page: Page): Promise<{ repoName: string; npub: string }> {
  await navigateToPublicFolder(page, { requireRelay: false });

  const npub = await page.evaluate(() => {
    const appWindow = window as Window & {
      __nostrStore?: { getState?: () => { npub?: string } };
    };
    return appWindow.__nostrStore?.getState?.()?.npub || '';
  });
  const repoName = `git-bar-${Date.now()}`;
  const repoPath = await createTempGitRepo();
  const files = await collectRepoFiles(repoPath);

  await page.evaluate(async ({ repoName, files }) => {
    const { uploadFilesWithPaths } = await import('/src/stores/upload.ts');
    const filesWithPaths = files.map((entry: { relativePath: string; content: number[] }) => {
      const name = entry.relativePath.split('/').pop() || 'file';
      const data = new Uint8Array(entry.content);
      const file = new File([data], name);
      return { file, relativePath: `${repoName}/${entry.relativePath}` };
    });
    await uploadFilesWithPaths(filesWithPaths);
  }, { repoName, files });

  await page.waitForTimeout(250);

  return { repoName, npub };
}

async function installFlashTracker(page: Page, selector: string, key: string): Promise<void> {
  await page.addInitScript(({ selector, key }: { selector: string; key: string }) => {
    const trackerWindow = window as Window & { __flashTracker?: Record<string, boolean> };
    trackerWindow.__flashTracker ??= {};
    trackerWindow.__flashTracker[key] = false;

    const markIfSidebarVisible = () => {
      if (document.querySelector(selector)) {
        trackerWindow.__flashTracker![key] = true;
      }
    };

    const startTracking = () => {
      markIfSidebarVisible();
      const observer = new MutationObserver(() => {
        markIfSidebarVisible();
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
      });
    };

    if (document.documentElement) {
      startTracking();
    } else {
      document.addEventListener('DOMContentLoaded', startTracking, { once: true });
    }
  }, { selector, key });
}

async function installSidebarFlashTracker(page: Page): Promise<void> {
  await installFlashTracker(page, GENERIC_SIDEBAR_SELECTOR, 'sidebar');
}

test.describe('Git file bar', () => {
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await gotoGitApp(page);
    await waitForAppReady(page);
    await disableOthersPool(page);
  });

  test('repo pages constrain the main column and keep file-view git path context', async ({ page }) => {
    test.slow();

    await page.setViewportSize({ width: 1800, height: 900 });

    const { repoName, npub } = await uploadGitRepo(page);

    await page.goto(`/git.html#/${npub}/public/${repoName}?g=${encodeURIComponent(repoName)}`);
    await waitForAppReady(page);

    const repoColumn = page.getByTestId('repo-main-column');
    await expect(repoColumn).toBeVisible({ timeout: 30000 });
    const repoColumnBox = await repoColumn.boundingBox();
    expect(repoColumnBox?.width ?? 0).toBeLessThanOrEqual(1290);

    const repoProjectSidebar = page.getByTestId('repo-project-sidebar');
    await expect(repoProjectSidebar).toContainText('Temporary repository for git view tests.');
    await expect(repoProjectSidebar.getByRole('link', { name: 'example.com/git-file-bar' })).toBeVisible({ timeout: 30000 });

    const repoFileList = page.locator('[data-testid="file-list"]').last();
    const dirCell = repoFileList.locator('tbody tr td:nth-child(2)').filter({ hasText: SUBDIR_NAME }).first();
    await expect(dirCell).toBeVisible({ timeout: 30000 });
    await dirCell.click();
    await page.waitForFunction(
      (dir) => window.location.hash.includes(encodeURIComponent(dir)),
      SUBDIR_NAME,
      { timeout: 15000 }
    );

    const fileCell = repoFileList.locator('tbody tr td:nth-child(2)').filter({ hasText: SUBFILE_NAME }).first();
    await expect(fileCell).toBeVisible({ timeout: 30000 });
    await fileCell.click();
    await page.waitForFunction(
      (name) => window.location.hash.includes(encodeURIComponent(name)),
      SUBFILE_NAME,
      { timeout: 15000 }
    );

    await expect(page.getByTestId('viewer-context')).toHaveText(`${repoName} / ${SUBDIR_NAME} / ${SUBFILE_NAME}`);

    const sidebarFileBrowser = page.locator(GENERIC_SIDEBAR_SELECTOR);
    await expect(sidebarFileBrowser).toHaveCount(1);

    const fileColumn = page.getByTestId('repo-file-column');
    await expect(fileColumn).toBeVisible({ timeout: 30000 });
    const fileColumnBox = await fileColumn.boundingBox();
    expect(fileColumnBox?.width ?? 0).toBeGreaterThan(1290);
  });

  test('shows commit info when viewing a file in git repo', async ({ page }) => {
    test.slow();

    const { repoName, npub } = await uploadGitRepo(page);

    await page.goto(`/git.html#/${npub}/public/${repoName}/${README_NAME}?g=${encodeURIComponent(repoName)}`);
    await waitForAppReady(page);

    const gitBar = page.locator('[data-testid="git-file-bar"]');
    await expect(gitBar).toBeVisible({ timeout: 60000 });
    await expect(gitBar.locator('button[title*="history" i]')).toBeVisible({ timeout: 60000 });
    await expect(gitBar.getByText(/\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago/i)).toBeVisible();
  });

  test('keeps the file browser sidebar off repo pages but shows it on git file pages', async ({ page }) => {
    test.slow();

    const { repoName, npub } = await uploadGitRepo(page);

    await page.goto(`/git.html#/${npub}/public/${repoName}?g=${encodeURIComponent(repoName)}`);
    await waitForAppReady(page);

    const sidebarFileBrowser = page.locator(GENERIC_SIDEBAR_SELECTOR);
    await expect(sidebarFileBrowser).toHaveCount(0);

    const repoFileList = page.locator('[data-testid="file-list"]').last();
    const readmeCell = repoFileList.locator('tbody tr td:nth-child(2)').filter({ hasText: README_NAME }).first();
    await expect(readmeCell).toBeVisible({ timeout: 30000 });
    await readmeCell.click();
    await page.waitForFunction(
      (name) => window.location.hash.includes(encodeURIComponent(name)),
      README_NAME,
      { timeout: 15000 }
    );

    await expect(sidebarFileBrowser).toHaveCount(1);
    await expect(page.locator('[data-testid="viewer-header"]')).toBeVisible({ timeout: 30000 });
  });

  test('direct repository links never flash the generic file browser sidebar', async ({ page }) => {
    test.slow();

    const { repoName, npub } = await uploadGitRepo(page);
    await installSidebarFlashTracker(page);

    await page.goto(`/git.html#/${npub}/public/${repoName}`);
    await waitForAppReady(page);

    await expect(page.getByRole('button', { name: /commits/i })).toBeVisible({ timeout: 60000 });
    await expect(page.locator(GENERIC_SIDEBAR_SELECTOR)).toHaveCount(0);
    await page.waitForTimeout(250);

    const sidebarFlashed = await page.evaluate(() => {
      return (window as { __sidebarFlashSeen?: boolean }).__sidebarFlashSeen === true;
    });
    expect(sidebarFlashed).toBe(false);
  });

  test('git permalinks for subdirectory files do not render the generic file browser sidebar', async ({ page }) => {
    test.slow();

    const { repoName, npub } = await uploadGitRepo(page);

    await page.goto(`/git.html#/${npub}/public/${repoName}?g=${encodeURIComponent(repoName)}`);
    await waitForAppReady(page);

    const repoFileList = page.locator('[data-testid="file-list"]').last();
    const dirCell = repoFileList.locator('tbody tr td:nth-child(2)').filter({ hasText: SUBDIR_NAME }).first();
    await expect(dirCell).toBeVisible({ timeout: 30000 });
    await dirCell.click();
    await page.waitForFunction(
      (dir) => window.location.hash.includes(encodeURIComponent(dir)),
      SUBDIR_NAME,
      { timeout: 15000 }
    );

    const fileCell = repoFileList.locator('tbody tr td:nth-child(2)').filter({ hasText: SUBFILE_NAME }).first();
    await expect(fileCell).toBeVisible({ timeout: 30000 });
    await fileCell.click();
    await page.waitForFunction(
      (name) => window.location.hash.includes(encodeURIComponent(name)),
      SUBFILE_NAME,
      { timeout: 15000 }
    );

    const permalinkLink = page.getByTestId('viewer-permalink');
    await expect(permalinkLink).toBeVisible({ timeout: 30000 });

    const permalinkHref = await permalinkLink.getAttribute('href');
    expect(permalinkHref).toBeTruthy();
    expect(permalinkHref).toMatch(/^#\/nhash1/);

    await page.goto(`/git.html${permalinkHref}`);
    await waitForAppReady(page);

    const sidebarFileBrowser = page.locator(GENERIC_SIDEBAR_SELECTOR);
    await expect(sidebarFileBrowser).toHaveCount(1);
    await expect(page.locator('[data-testid="viewer-header"]')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('hello from subdir')).toBeVisible({ timeout: 30000 });
  });

  test('clicking a git permalink does not flash directory actions before file view resolves', async ({ page }) => {
    test.slow();

    const { repoName, npub } = await uploadGitRepo(page);
    await installFlashTracker(page, DIRECTORY_ACTIONS_ADD_FILES_SELECTOR, 'add-files');

    await page.goto(`/git.html#/${npub}/public/${repoName}?g=${encodeURIComponent(repoName)}`);
    await waitForAppReady(page);

    const repoFileList = page.locator('[data-testid="file-list"]').last();
    const dirCell = repoFileList.locator('tbody tr td:nth-child(2)').filter({ hasText: SUBDIR_NAME }).first();
    await expect(dirCell).toBeVisible({ timeout: 30000 });
    await dirCell.click();
    await page.waitForFunction(
      (dir) => window.location.hash.includes(encodeURIComponent(dir)),
      SUBDIR_NAME,
      { timeout: 15000 }
    );

    const fileCell = repoFileList.locator('tbody tr td:nth-child(2)').filter({ hasText: SUBFILE_NAME }).first();
    await expect(fileCell).toBeVisible({ timeout: 30000 });
    await fileCell.click();
    await page.waitForFunction(
      (name) => window.location.hash.includes(encodeURIComponent(name)),
      SUBFILE_NAME,
      { timeout: 15000 }
    );

    const permalinkLink = page.getByTestId('viewer-permalink');
    await expect(permalinkLink).toBeVisible({ timeout: 30000 });

    await permalinkLink.click();
    await page.waitForFunction(() => window.location.hash.startsWith('#/nhash1'), undefined, { timeout: 15000 });
    await waitForAppReady(page);
    await expect(page.locator(GENERIC_SIDEBAR_SELECTOR)).toHaveCount(1);

    const addFilesFlashed = await page.evaluate(() => {
      const trackerWindow = window as Window & { __flashTracker?: Record<string, boolean> };
      return trackerWindow.__flashTracker?.['add-files'] === true;
    });
    expect(addFilesFlashed).toBe(false);
  });

  test('clicking history opens git history modal', async ({ page }) => {
    test.slow();

    const { repoName, npub } = await uploadGitRepo(page);

    await page.goto(`/git.html#/${npub}/public/${repoName}/${README_NAME}?g=${encodeURIComponent(repoName)}`);
    await waitForAppReady(page);

    const gitBar = page.locator('[data-testid="git-file-bar"]');
    await expect(gitBar).toBeVisible({ timeout: 60000 });
    await expect(gitBar.locator('button[title*="history" i]')).toBeVisible({ timeout: 60000 });
    await gitBar.locator('button[title*="history" i]').click();
    await expect(page.locator('[data-testid="git-history-modal"]')).toBeVisible({ timeout: 10000 });
  });

  test('shows git bar when viewing file in subdirectory via navigation', async ({ page }) => {
    test.slow();

    const { repoName, npub } = await uploadGitRepo(page);

    await page.goto(`/git.html#/${npub}/public/${repoName}?g=${encodeURIComponent(repoName)}`);
    await waitForAppReady(page);

    const fileList = page.locator('[data-testid="file-list"]').last();
    const dirCell = fileList.locator('tbody tr td:nth-child(2)').filter({ hasText: SUBDIR_NAME }).first();
    await expect(dirCell).toBeVisible({ timeout: 30000 });
    await dirCell.click();
    await page.waitForFunction(
      (dir) => window.location.hash.includes(encodeURIComponent(dir)),
      SUBDIR_NAME,
      { timeout: 15000 }
    );

    const fileCell = fileList.locator('tbody tr td:nth-child(2)').filter({ hasText: SUBFILE_NAME }).first();
    await expect(fileCell).toBeVisible({ timeout: 30000 });
    await fileCell.click();
    await page.waitForFunction(
      (name) => window.location.hash.includes(encodeURIComponent(name)),
      SUBFILE_NAME,
      { timeout: 15000 }
    );

    const gitBar = page.locator('[data-testid="git-file-bar"]');
    await expect(gitBar).toBeVisible({ timeout: 60000 });
    await expect(gitBar.getByText(/\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago/i)).toBeVisible();
  });

  test('direct deep links into repo subdirectories still use git UI without flashing directory actions', async ({ page }) => {
    test.slow();

    const { repoName, npub } = await uploadGitRepo(page);
    await installFlashTracker(page, DIRECTORY_ACTIONS_ADD_FILES_SELECTOR, 'add-files');

    await page.goto(`/git.html#/${npub}/public/${repoName}/${SUBDIR_NAME}`);
    await waitForAppReady(page);

    await expect(page.getByRole('button', { name: /commits/i })).toBeVisible({ timeout: 60000 });

    const fileList = page.locator('[data-testid="file-list"]').last();
    const fileCell = fileList.locator('tbody tr td:nth-child(2)').filter({ hasText: SUBFILE_NAME }).first();
    await expect(fileCell).toBeVisible({ timeout: 30000 });
    await fileCell.click();

    const gitBar = page.locator('[data-testid="git-file-bar"]');
    await expect(gitBar).toBeVisible({ timeout: 60000 });
    await expect(page.locator(GENERIC_SIDEBAR_SELECTOR)).toHaveCount(1);

    const addFilesFlashed = await page.evaluate(() => {
      const trackerWindow = window as Window & { __flashTracker?: Record<string, boolean> };
      return trackerWindow.__flashTracker?.['add-files'] === true;
    });
    expect(addFilesFlashed).toBe(false);
  });
});
