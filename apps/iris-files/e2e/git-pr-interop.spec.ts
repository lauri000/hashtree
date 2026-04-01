import { test, expect, type Page } from './fixtures';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { acquireRustLock, releaseRustLock } from './rust-lock.js';
import { rustTargetPath, withRustTargetEnv } from './rust-target.js';
import {
  clearAllStorage,
  commitCurrentDirectoryChanges,
  configureBlossomServers,
  disableOthersPool,
  flushPendingPublishes,
  getTestBlossomUrl,
  gotoGitApp,
  loginAsTestUser,
  presetLocalRelayInDB,
  safeGoto,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForGitRepoReady,
  waitForRelayConnected,
} from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUST_WORKSPACE_DIR = path.resolve(__dirname, '../../../rust');
const RUST_DEBUG_DIR = rustTargetPath('debug');

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  combined: string;
};

type OwnerFixture = {
  homeDir: string;
  configDir: string;
  dataDir: string;
  localRepoDir: string;
  repoPath: string;
  pubkey: string;
  npub: string;
  nsec: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
};

let htreeBin = '';
let gitRemoteHtreeBin = '';
let relayProcess: ChildProcess | null = null;
let dedicatedRelayUrl = '';

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
  } = {}
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = `${stdout}${stderr}`;

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        `cwd: ${options.cwd ?? process.cwd()}`,
        combined.trim(),
      ].join('\n')
    );
  }

  return {
    status: result.status,
    stdout,
    stderr,
    combined,
  };
}

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): CommandResult {
  return runCommand('git', args, { cwd, env });
}

function runHtree(args: string[], env: NodeJS.ProcessEnv, cwd?: string): CommandResult {
  return runCommand(htreeBin, args, { cwd, env });
}

async function waitForHtreePrOutput(
  fixture: OwnerFixture,
  args: string[],
  predicate: (result: CommandResult) => boolean,
  timeoutMs: number = 30000,
): Promise<CommandResult> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = runHtree(args, fixture.env, fixture.localRepoDir);
    if (predicate(result)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return runHtree(args, fixture.env, fixture.localRepoDir);
}

function ensureRustGitBinaries(): void {
  execFileSync('cargo', ['build', '-p', 'hashtree-cli', '--bin', 'htree'], {
    cwd: RUST_WORKSPACE_DIR,
    env: withRustTargetEnv(),
    stdio: 'inherit',
  });
  execFileSync('cargo', ['build', '-p', 'git-remote-htree'], {
    cwd: RUST_WORKSPACE_DIR,
    env: withRustTargetEnv(),
    stdio: 'inherit',
  });

  htreeBin = path.join(RUST_DEBUG_DIR, 'htree');
  gitRemoteHtreeBin = path.join(RUST_DEBUG_DIR, 'git-remote-htree');

  if (!fs.existsSync(htreeBin) || !fs.existsSync(gitRemoteHtreeBin)) {
    throw new Error('Expected htree and git-remote-htree binaries after cargo build');
  }
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve free port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForRelayReady(port: number, timeoutMs = 10000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const ready = await new Promise<boolean>((resolve) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: '/',
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );

      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });

    if (ready) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for relay on port ${port}`);
}

async function startDedicatedRelay(): Promise<string> {
  const port = await findFreePort();
  const relay = spawn('node', ['e2e/relay/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      TEST_RELAY_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  relay.stdout?.on('data', () => {});
  relay.stderr?.on('data', () => {});

  relayProcess = relay;
  await waitForRelayReady(port);
  return `ws://127.0.0.1:${port}`;
}

function createOwnerFixture(relayUrl: string, repoPath: string): OwnerFixture {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const nsec = nip19.nsecEncode(secretKey);
  const npub = nip19.npubEncode(pubkey);

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htree-pr-interop-'));
  const configDir = path.join(homeDir, '.hashtree');
  const dataDir = path.join(homeDir, 'data');
  const localRepoDir = path.join(homeDir, 'repo');
  const blossomUrl = getTestBlossomUrl();

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(localRepoDir, { recursive: true });

  const configToml = [
    '[server]',
    'enable_auth = false',
    'enable_webrtc = false',
    'stun_port = 0',
    '',
    '[nostr]',
    `relays = ["${relayUrl}"]`,
    'social_graph_crawl_depth = 0',
    '',
    '[blossom]',
    `read_servers = ["${blossomUrl}"]`,
    `write_servers = ["${blossomUrl}"]`,
    'max_upload_mb = 50',
    '',
    '[sync]',
    'enabled = false',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(configDir, 'config.toml'), configToml);
  fs.writeFileSync(path.join(configDir, 'keys'), `${nsec} self\n`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    HTREE_CONFIG_DIR: configDir,
    HTREE_DATA_DIR: dataDir,
    NOSTR_RELAYS: relayUrl,
    NOSTR_PREFER_LOCAL: '0',
    HTREE_PREFER_LOCAL_RELAY: '0',
    HTREE_PREFER_LOCAL_DAEMON: '0',
    PATH: `${path.dirname(gitRemoteHtreeBin)}:${process.env.PATH ?? ''}`,
  };

  runGit(['init', '-b', 'master'], localRepoDir, env);
  runGit(['config', 'user.email', 'test@example.com'], localRepoDir, env);
  runGit(['config', 'user.name', 'Interop Test'], localRepoDir, env);

  fs.writeFileSync(path.join(localRepoDir, 'README.md'), `# ${repoPath}\n`);
  runGit(['add', 'README.md'], localRepoDir, env);
  runGit(['commit', '-m', 'Initial commit'], localRepoDir, env);
  runGit(['remote', 'add', 'origin', `htree://self/${repoPath}`], localRepoDir, env);
  runGit(['push', 'origin', 'master'], localRepoDir, env);

  return {
    homeDir,
    configDir,
    dataDir,
    localRepoDir,
    repoPath,
    pubkey,
    npub,
    nsec,
    env,
    cleanup: () => {
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

function createAndPushFeatureBranch(
  fixture: OwnerFixture,
  branchName: string,
  filename: string,
  content: string
): void {
  runGit(['checkout', '-b', branchName], fixture.localRepoDir, fixture.env);
  fs.writeFileSync(path.join(fixture.localRepoDir, filename), content);
  runGit(['add', filename], fixture.localRepoDir, fixture.env);
  runGit(['commit', '-m', `Add ${filename}`], fixture.localRepoDir, fixture.env);
  runGit(['push', 'origin', branchName], fixture.localRepoDir, fixture.env);
  runGit(['checkout', 'master'], fixture.localRepoDir, fixture.env);
}

async function setupOwnerInGitApp(page: Page, relayUrl: string, nsec: string): Promise<void> {
  setupPageErrorHandler(page);
  await gotoGitApp(page);
  await clearAllStorage(page);
  await presetLocalRelayInDB(page, relayUrl);
  await gotoGitApp(page);
  await loginAsTestUser(page, nsec);
  await waitForAppReady(page, 60000);
  await disableOthersPool(page);
  await useLocalRelay(page, relayUrl);
  await configureBlossomServers(page);
  await waitForRelayConnected(page, 20000);
}

async function openRepoInGitApp(page: Page, npub: string, repoPath: string): Promise<void> {
  await safeGoto(page, `/git.html#/${npub}/${repoPath}`, { timeoutMs: 60000, retries: 4 });
  await waitForAppReady(page, 60000);
  await expect(page.locator('[data-testid="repo-header-row"]')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-testid="file-list"]')).toBeVisible({ timeout: 30000 });
  await waitForGitRepoReady(page, 60000);
}

async function createPullRequestInIrisGit(
  page: Page,
  npub: string,
  repoPath: string,
  title: string,
  branch: string
): Promise<void> {
  await safeGoto(page, `/git.html#/${npub}/${repoPath}?branch=${encodeURIComponent(branch)}`, { timeoutMs: 60000, retries: 4 });
  await waitForGitRepoReady(page, 60000);
  const commitTipHandle = await page.waitForFunction(async (expectedBranch) => {
    const { useCurrentDirCid } = await import('/src/stores/index.ts');
    const { getHead, getRefs } = await import('/src/utils/git.ts');

    const dirCid = useCurrentDirCid();
    if (!dirCid) {
      return null;
    }

    const refs = await getRefs(dirCid);
    if (refs.currentBranch !== expectedBranch) {
      return null;
    }

    return await getHead(dirCid);
  }, branch, { timeout: 30000 });
  const commitTip = await commitTipHandle.jsonValue<string | null>();
  if (!commitTip) {
    throw new Error(`Could not resolve branch tip for ${branch}`);
  }

  await page.evaluate(async ({ targetNpub, targetRepoPath, prTitle, sourceBranch, sourceCommitTip }) => {
    const { createPullRequest } = await import('/src/nip34.ts');

    const created = await createPullRequest(targetNpub, targetRepoPath, prTitle, 'interop test PR', {
      branch: sourceBranch,
      targetBranch: 'master',
      commitTip: sourceCommitTip,
    });

    if (!created) {
      throw new Error('Failed to create PR from iris-git');
    }
  }, { targetNpub: npub, targetRepoPath: repoPath, prTitle: title, sourceBranch: branch, sourceCommitTip: commitTip });
}

async function waitForPullRequestInIrisGit(page: Page, npub: string, repoPath: string, title: string): Promise<void> {
  await safeGoto(page, `/git.html#/${npub}/${repoPath}?tab=pulls`, { timeoutMs: 60000, retries: 4 });
  await expect(page.locator('text=Loading pull requests...')).not.toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('link', { name: title })).toBeVisible({ timeout: 20000 });
}

function assertOutputContains(output: CommandResult, expected: string): void {
  expect(output.combined).toContain(expected);
}

test.describe('iris-git <-> htree PR interop', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(240000);
    const rustLockFd = await acquireRustLock(240000);
    try {
      ensureRustGitBinaries();
      dedicatedRelayUrl = await startDedicatedRelay();
    } finally {
      releaseRustLock(rustLockFd);
    }
  });

  test.afterAll(() => {
    if (relayProcess) {
      relayProcess.kill('SIGTERM');
      relayProcess = null;
    }
  });

  test('PRs created in iris-git are listed by htree and become applied after htree-side merge', async ({ page }) => {
    const repoPath = `ui-pr-interop-${Date.now()}`;
    const featureBranch = 'feature-ui';
    const prTitle = 'iris-git created PR';
    const fixture = createOwnerFixture(dedicatedRelayUrl, repoPath);

    try {
      createAndPushFeatureBranch(
        fixture,
        featureBranch,
        'ui-feature.txt',
        'content created for iris-git -> htree PR interop\n'
      );

      await setupOwnerInGitApp(page, dedicatedRelayUrl, fixture.nsec);
      await openRepoInGitApp(page, fixture.npub, repoPath);

      await createPullRequestInIrisGit(page, fixture.npub, repoPath, prTitle, featureBranch);
      await waitForPullRequestInIrisGit(page, fixture.npub, repoPath, prTitle);
      await page.waitForTimeout(2500);

      const repoUrl = `htree://${fixture.npub}/${repoPath}`;
      const listed = await waitForHtreePrOutput(
        fixture,
        ['pr', 'list', repoUrl],
        (result) => result.combined.includes(prTitle),
      );
      assertOutputContains(listed, prTitle);

      runGit(['merge', featureBranch, '--no-ff', '-m', `Merge ${featureBranch}`], fixture.localRepoDir, fixture.env);
      runGit(['push', 'origin', 'master'], fixture.localRepoDir, fixture.env);

      await page.waitForTimeout(1500);

      const applied = await waitForHtreePrOutput(
        fixture,
        ['pr', 'list', repoUrl, '--state', 'applied'],
        (result) => result.combined.includes(prTitle),
      );
      assertOutputContains(applied, prTitle);

      const openOnly = await waitForHtreePrOutput(
        fixture,
        ['pr', 'list', repoUrl],
        (result) => !result.combined.includes(prTitle),
      );
      expect(openOnly.combined).not.toContain(prTitle);
    } finally {
      fixture.cleanup();
    }
  });

  test('PRs created with htree are listed and merged in iris-git for the repo owner', async ({ page }) => {
    const repoPath = `cli-pr-interop-${Date.now()}`;
    const featureBranch = 'feature-cli';
    const prTitle = 'htree created PR';
    const fixture = createOwnerFixture(dedicatedRelayUrl, repoPath);

    try {
      createAndPushFeatureBranch(
        fixture,
        featureBranch,
        'cli-feature.txt',
        'content created for htree -> iris-git PR interop\n'
      );

      const repoUrl = `htree://${fixture.npub}/${repoPath}`;
      const created = runHtree(
        [
          'pr',
          'create',
          repoUrl,
          '--title',
          prTitle,
          '--description',
          'interop test PR',
          '--branch',
          featureBranch,
          '--target-branch',
          'master',
        ],
        fixture.env,
        fixture.localRepoDir
      );
      assertOutputContains(created, prTitle);

      await setupOwnerInGitApp(page, dedicatedRelayUrl, fixture.nsec);
      await openRepoInGitApp(page, fixture.npub, repoPath);
      await waitForPullRequestInIrisGit(page, fixture.npub, repoPath, prTitle);

      await page.getByRole('link', { name: prTitle }).click();
      await expect(page.getByRole('button', { name: 'Merge' })).toBeVisible({ timeout: 20000 });
      await page.getByRole('button', { name: 'Merge' }).click();

      const confirmMerge = page.getByRole('button', { name: 'Confirm merge' });
      await expect(confirmMerge).toBeVisible({ timeout: 20000 });
      await confirmMerge.click();

      await expect(page.getByText('Merge successful!')).toBeVisible({ timeout: 30000 });
      await flushPendingPublishes(page);
      await page.waitForTimeout(1500);

      const applied = await waitForHtreePrOutput(
        fixture,
        ['pr', 'list', repoUrl, '--state', 'applied'],
        (result) => result.combined.includes(prTitle),
        45000,
      );
      assertOutputContains(applied, prTitle);
    } finally {
      fixture.cleanup();
    }
  });
});
