import { test, expect, type Page } from './fixtures';
import {
  createRepositoryInCurrentDirectory,
  disableOthersPool,
  ensureLoggedIn,
  flushPendingPublishes,
  gotoGitApp,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils.js';

type RepoAnnouncementSnapshot = {
  address: string;
  cloneUrls: string[];
  earliestUniqueCommit: string | null;
  isPersonalFork: boolean;
} | null;

type RepoMetadataSnapshot = {
  path: string;
  content: string;
} | null;

async function prepareUser(page: Page) {
  setupPageErrorHandler(page);
  await gotoGitApp(page);
  await waitForAppReady(page);
  await disableOthersPool(page);
  await useLocalRelay(page);
  await ensureLoggedIn(page);
  await waitForRelayConnected(page);
}

async function getLoggedInNpub(page: Page): Promise<string> {
  const npub = await page.evaluate(() => (
    (window as { __nostrStore?: { getState?: () => { npub?: string | null } } }).__nostrStore?.getState?.().npub ?? null
  ));

  if (!npub) {
    throw new Error('Failed to resolve logged-in npub');
  }

  return npub;
}

async function fetchRepoAnnouncementSnapshot(page: Page, npub: string, repoName: string): Promise<RepoAnnouncementSnapshot> {
  return page.evaluate(async ({ ownerNpub, repositoryName }) => {
    const { fetchRepoAnnouncement } = await import('/src/nip34.ts');
    const announcement = await fetchRepoAnnouncement(ownerNpub, repositoryName);
    if (!announcement) {
      return null;
    }

    return {
      address: announcement.address,
      cloneUrls: announcement.cloneUrls,
      earliestUniqueCommit: announcement.earliestUniqueCommit,
      isPersonalFork: announcement.isPersonalFork,
    };
  }, { ownerNpub: npub, repositoryName: repoName });
}

async function waitForRepoAnnouncement(
  page: Page,
  npub: string,
  repoName: string,
  predicate: (snapshot: NonNullable<RepoAnnouncementSnapshot>) => boolean,
  timeoutMs: number = 30000,
): Promise<NonNullable<RepoAnnouncementSnapshot>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const announcement = await fetchRepoAnnouncementSnapshot(page, npub, repoName);
    if (announcement && predicate(announcement)) {
      return announcement;
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for repo announcement for ${npub}/${repoName}`);
}

async function readRepoMetadataFile(page: Page): Promise<RepoMetadataSnapshot> {
  return page.evaluate(async () => {
    const { useCurrentDirCid } = await import('/src/stores/index.ts');
    const { decodeAsText, getTree } = await import('/src/store.ts');

    const repoCid = useCurrentDirCid();
    if (!repoCid) {
      return null;
    }

    const tree = getTree();
    for (const path of ['.hashtree/project.toml', '.hashtree/meta.toml']) {
      try {
        const entry = await tree.resolvePath(repoCid, path);
        if (!entry) {
          continue;
        }

        const data = await tree.readFile(entry.cid);
        if (!data) {
          continue;
        }

        return {
          path,
          content: decodeAsText(data) ?? new TextDecoder().decode(data),
        };
      } catch {
        // Try the next candidate metadata path.
      }
    }

    return null;
  });
}

async function waitForRepoMetadataFile(
  page: Page,
  predicate: (snapshot: NonNullable<RepoMetadataSnapshot>) => boolean = () => true,
  timeoutMs: number = 30000,
): Promise<NonNullable<RepoMetadataSnapshot>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const metadata = await readRepoMetadataFile(page);
    if (metadata && predicate(metadata)) {
      return metadata;
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for repo metadata on ${page.url()}`);
}

async function waitForCurrentRepoLoaded(page: Page, npub: string, repoName: string, timeoutMs: number = 30000) {
  await page.waitForFunction(
    async ({ ownerNpub, repositoryName }) => {
      const { getRouteSync, useCurrentDirCid } = await import('/src/stores/index.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { isGitRepo } = await import('/src/utils/git.ts');

      const route = getRouteSync();
      const dirCid = useCurrentDirCid();
      if (!getCurrentRootCid() || !dirCid) {
        return false;
      }

      return (
        route.npub === ownerNpub &&
        route.treeName === repositoryName &&
        route.path.length === 0 &&
        await isGitRepo(dirCid)
      );
    },
    { ownerNpub: npub, repositoryName: repoName },
    { timeout: timeoutMs },
  );
}

async function forkCurrentRepo(page: Page, forkName: string) {
  const forkButton = page.locator('button[title="Fork as new top-level folder"]:visible').first();
  await expect(forkButton).toBeVisible({ timeout: 15000 });
  await forkButton.click();

  const forkModal = page.locator('.fixed.inset-0').filter({ hasText: 'Fork as New Folder' });
  await expect(forkModal).toBeVisible({ timeout: 10000 });
  await forkModal.locator('input').fill(forkName);
  await forkModal.getByRole('button', { name: /^Fork$/ }).click();
  await expect(forkModal).not.toBeVisible({ timeout: 30000 });
}

test.describe('Git forks', () => {
  test('forking another user repo writes metadata, publishes a personal fork announcement, and increments fork count', { timeout: 120000 }, async ({ page, browser }) => {
    test.slow();

    await prepareUser(page);
    const ownerNpub = await getLoggedInNpub(page);

    const sourceRepoName = `fork-source-${Date.now()}`;
    await createRepositoryInCurrentDirectory(page, sourceRepoName);
    await flushPendingPublishes(page);

    const sourceAnnouncement = await waitForRepoAnnouncement(
      page,
      ownerNpub,
      sourceRepoName,
      announcement => !announcement.isPersonalFork && !!announcement.earliestUniqueCommit,
    );

    const sourceRepoUrl = `/git.html#/${ownerNpub}/${sourceRepoName}`;
    await page.goto(sourceRepoUrl);
    await waitForAppReady(page);
    await waitForCurrentRepoLoaded(page, ownerNpub, sourceRepoName);

    const forkStats = page.locator('[title="Personal forks announced via NIP-34"]').first();
    await expect(forkStats).toContainText('Forks', { timeout: 15000 });
    await expect(forkStats).toContainText('0', { timeout: 15000 });

    const viewerContext = await browser.newContext();
    try {
      const viewerPage = await viewerContext.newPage();
      await prepareUser(viewerPage);
      const viewerNpub = await getLoggedInNpub(viewerPage);
      expect(viewerNpub).not.toBe(ownerNpub);

      await viewerPage.goto(sourceRepoUrl);
      await waitForAppReady(viewerPage);
      await waitForCurrentRepoLoaded(viewerPage, ownerNpub, sourceRepoName);

      const forkRepoName = `fork-copy-${Date.now()}`;
      await forkCurrentRepo(viewerPage, forkRepoName);
      await viewerPage.waitForURL(new RegExp(`${encodeURIComponent(forkRepoName)}(?:\\?|$)`), { timeout: 30000 });
      await waitForAppReady(viewerPage);
      await waitForCurrentRepoLoaded(viewerPage, viewerNpub, forkRepoName);
      await flushPendingPublishes(viewerPage);

      const metadata = await waitForRepoMetadataFile(
        viewerPage,
        snapshot => snapshot.path === '.hashtree/project.toml' && snapshot.content.includes(`forked_from = "htree://${ownerNpub}/${sourceRepoName}"`),
      );
      expect(metadata.path).toBe('.hashtree/project.toml');
      expect(metadata.content).toContain(`forked_from = "htree://${ownerNpub}/${sourceRepoName}"`);

      const forkAnnouncement = await waitForRepoAnnouncement(
        viewerPage,
        viewerNpub,
        forkRepoName,
        () => true,
      );
      expect(forkAnnouncement.isPersonalFork).toBe(true);
      expect(forkAnnouncement.earliestUniqueCommit).toBe(sourceAnnouncement.earliestUniqueCommit);
      expect(forkAnnouncement.cloneUrls).toContain(`htree://${viewerNpub}/${forkRepoName}`);

      const repoSidebar = viewerPage.getByTestId('repo-project-sidebar');
      const forkOriginText = `Forked from ${ownerNpub}/${sourceRepoName}`;
      await expect(repoSidebar).toContainText(forkOriginText, { timeout: 30000 });
      await expect(repoSidebar.getByRole('link', { name: forkOriginText })).toHaveAttribute(
        'href',
        `#/${ownerNpub}/${sourceRepoName}`,
      );

      await page.goto(sourceRepoUrl);
      await waitForAppReady(page);
      await waitForCurrentRepoLoaded(page, ownerNpub, sourceRepoName);
      await expect(forkStats).toContainText('1', { timeout: 30000 });
    } finally {
      await viewerContext.close();
    }
  });
});
