import { describe, expect, it, vi } from 'vitest';
import {
  createReleasePlan,
  parseArgs,
  parsePublishOutput,
  runAllReleases,
  runRelease,
  wranglerVersion,
} from '../scripts/release-site.mjs';

describe('release-site', () => {
  const wranglerCommand = `wrangler@${wranglerVersion}`;

  it('uses the built-in Worker default for files', () => {
    const parsed = parseArgs(['files']);
    expect(parsed.workerName).toBe('iris-files');
    expect(parsed.treeName).toBe('files');
    expect(parsed.routes).toEqual([]);
    expect(parsed.domains).toEqual([]);
  });

  it('uses the built-in Worker default for git', () => {
    const parsed = parseArgs(['git']);
    expect(parsed.workerName).toBe('iris-git');
    expect(parsed.treeName).toBe('git');
    expect(parsed.routes).toEqual([]);
    expect(parsed.domains).toEqual([]);
  });

  it('uses the built-in Worker defaults for video, docs, and maps', () => {
    const video = parseArgs(['video']);
    const docs = parseArgs(['docs']);
    const maps = parseArgs(['maps']);

    expect(video.workerName).toBe('iris-video');
    expect(video.routes).toEqual(['video.iris.to/*']);
    expect(video.domains).toEqual([]);
    expect(docs.workerName).toBe('iris-docs');
    expect(docs.routes).toEqual(['docs.iris.to/*']);
    expect(docs.domains).toEqual([]);
    expect(maps.workerName).toBe('iris-maps');
    expect(maps.routes).toEqual(['maps.iris.to/*']);
    expect(maps.domains).toEqual([]);
  });

  it('uses the built-in Worker default and custom domain for boards', () => {
    const parsed = parseArgs(['boards']);
    expect(parsed.workerName).toBe('iris-boards');
    expect(parsed.routes).toEqual([]);
    expect(parsed.domains).toEqual(['boards.iris.to']);
  });

  it('uses the profile-specific Worker env var without production routes or domains', () => {
    const parsed = parseArgs(['video'], { CF_WORKER_NAME_VIDEO: 'iris-video-preview' });
    expect(parsed.workerName).toBe('iris-video-preview');
    expect(parsed.treeName).toBe('video');
    expect(parsed.routes).toEqual([]);
    expect(parsed.domains).toEqual([]);
  });

  it('lets an explicit Worker env var override the built-in files default', () => {
    const parsed = parseArgs(['files'], { CF_WORKER_NAME_FILES: 'iris-files-staging' });
    expect(parsed.workerName).toBe('iris-files-staging');
  });

  it('supports explicitly switching a profile back to Pages', () => {
    const parsed = parseArgs(['video', '--pages-only'], { CF_PAGES_PROJECT_VIDEO: 'video-iris-to' });
    expect(parsed.workerName).toBeUndefined();
    expect(parsed.pagesProject).toBe('video-iris-to');
    expect(parsed.routes).toEqual([]);
    expect(parsed.domains).toEqual([]);
  });

  it('supports the all profile without per-site overrides', () => {
    const parsed = parseArgs(['all', '--branch', 'main', '--skip-cloudflare']);
    expect(parsed.profileName).toBe('all');
    expect(parsed.branch).toBe('main');
    expect(parsed.skipCloudflare).toBe(true);
  });

  it('rejects single-target Worker overrides for the all profile', () => {
    expect(() => parseArgs(['all', '--worker-name', 'iris-files'])).toThrow(
      '--worker-name is not supported with the all profile',
    );
  });

  it('supports docs, git, maps, and boards release profiles', () => {
    const docs = createReleasePlan({
      profileName: 'docs',
      pagesProject: 'docs-iris-to',
      treeName: 'docs',
      skipCloudflare: false,
    });
    const git = createReleasePlan({
      profileName: 'git',
      pagesProject: 'git-iris-to',
      treeName: 'git',
      skipCloudflare: false,
    });
    const maps = createReleasePlan({
      profileName: 'maps',
      pagesProject: 'maps-iris-to',
      treeName: 'maps',
      skipCloudflare: false,
    });
    const boards = createReleasePlan({
      profileName: 'boards',
      pagesProject: 'boards-iris-to',
      treeName: 'boards',
      skipCloudflare: false,
    });

    expect(docs.profile.distDir).toBe('dist-docs');
    expect(git.profile.distDir).toBe('iris-git');
    expect(maps.profile.distDir).toBe('dist-maps');
    expect(boards.profile.distDir).toBe('dist-boards');
  });

  it('adds the built-in production route for the video Worker release', () => {
    const plan = createReleasePlan({
      profileName: 'video',
      workerName: 'iris-video',
      routes: ['video.iris.to/*'],
      domains: [],
      treeName: 'video',
      skipCloudflare: false,
      workerCompatibilityDate: '2026-03-19',
    });

    expect(plan.steps.at(-1)?.command).toEqual([
      'npx',
      wranglerCommand,
      'deploy',
      '--assets',
      'dist-video',
      '--name',
      'iris-video',
      '--compatibility-date',
      '2026-03-19',
      '--keep-vars',
      '--route',
      'video.iris.to/*',
    ]);
  });

  it('adds the built-in production custom domain for the boards Worker release', () => {
    const plan = createReleasePlan({
      profileName: 'boards',
      workerName: 'iris-boards',
      routes: [],
      domains: ['boards.iris.to'],
      treeName: 'boards',
      skipCloudflare: false,
      workerCompatibilityDate: '2026-03-19',
    });

    expect(plan.steps.at(-1)?.command).toEqual([
      'npx',
      wranglerCommand,
      'deploy',
      '--assets',
      'dist-boards',
      '--name',
      'iris-boards',
      '--compatibility-date',
      '2026-03-19',
      '--keep-vars',
      '--domain',
      'boards.iris.to',
    ]);
  });

  it('builds a Worker release plan in build-test-publish-deploy order', () => {
    const plan = createReleasePlan({
      profileName: 'files',
      workerName: 'iris-files',
      treeName: 'files',
      skipCloudflare: false,
      workerCompatibilityDate: '2026-03-19',
    });

    expect(plan.steps.map((step) => step.id)).toEqual([
      'build',
      'test-1',
      'test-2',
      'publish',
      'deploy',
    ]);
    expect(plan.steps.at(-1)?.command).toEqual([
      'npx',
      wranglerCommand,
      'deploy',
      '--assets',
      'dist',
      '--name',
      'iris-files',
      '--compatibility-date',
      '2026-03-19',
      '--keep-vars',
    ]);
  });

  it('prefers a Worker deployment when both Worker and Pages targets are configured', () => {
    const plan = createReleasePlan({
      profileName: 'files',
      workerName: 'iris-files',
      pagesProject: 'files-iris-to',
      treeName: 'files',
      skipCloudflare: false,
      workerCompatibilityDate: '2026-03-19',
    });

    expect(plan.steps.at(-1)?.label).toBe('Deploy Iris Files to Cloudflare Worker');
  });

  it('builds a Pages release plan when only a Pages project is configured', () => {
    const plan = createReleasePlan({
      profileName: 'files',
      pagesProject: 'files-iris-to',
      treeName: 'files',
      branch: 'main',
      skipCloudflare: false,
    });

    expect(plan.steps.at(-1)?.command).toEqual([
      'npx',
      wranglerCommand,
      'pages',
      'deploy',
      'dist',
      '--project-name',
      'files-iris-to',
      '--branch',
      'main',
    ]);
  });

  it('rejects Pages-only branch flags for Worker deployments', () => {
    expect(() =>
      createReleasePlan({
        profileName: 'files',
        workerName: 'iris-files',
        treeName: 'files',
        branch: 'main',
        skipCloudflare: false,
        workerCompatibilityDate: '2026-03-19',
      }),
    ).toThrow('--branch is only supported for Pages deployments');
  });

  it('stops before publish when a test step fails', async () => {
    const calls = [];
    const runner = vi.fn((step) => {
      calls.push(step.id);
      if (step.id === 'test-2') {
        return { status: 1, stdout: '', stderr: 'smoke failed' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    await expect(
      runRelease(
        {
          profileName: 'video',
          workerName: 'iris-video',
          treeName: 'video',
          skipCloudflare: false,
          workerCompatibilityDate: '2026-03-19',
        },
        runner,
        { buildOutputExists: () => true },
      ),
    ).rejects.toThrow('Test Iris Video (2/2) failed with exit code 1');
    expect(calls).toEqual(['build', 'test-1', 'test-2']);
  });

  it('runs hashtree publish and Cloudflare deploy in parallel after tests', async () => {
    let activeReleaseSteps = 0;
    let maxActiveReleaseSteps = 0;
    const calls = [];
    const runner = vi.fn(async (step) => {
      calls.push(step.id);
      if (step.id === 'publish' || step.id === 'deploy') {
        activeReleaseSteps += 1;
        maxActiveReleaseSteps = Math.max(maxActiveReleaseSteps, activeReleaseSteps);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeReleaseSteps -= 1;
        if (step.id === 'publish') {
          return {
            status: 0,
            stdout: 'published: npub1example/video\nnhash1ace',
            stderr: '',
          };
        }
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    await runRelease(
      {
        profileName: 'video',
        workerName: 'iris-video',
        treeName: 'video',
        skipCloudflare: false,
        workerCompatibilityDate: '2026-03-19',
      },
      runner,
      { buildOutputExists: () => true },
    );

    expect(calls).toEqual(['build', 'test-1', 'test-2', 'publish', 'deploy']);
    expect(maxActiveReleaseSteps).toBe(2);
  });

  it('returns parsed hashtree and Worker target on success', async () => {
    const runner = vi.fn((step) => {
      if (step.id === 'publish') {
        return {
          status: 0,
          stdout: 'published: npub1example/video\nnhash1ace',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = await runRelease(
      {
        profileName: 'video',
        workerName: 'iris-video',
        treeName: 'video',
        skipCloudflare: false,
        workerCompatibilityDate: '2026-03-19',
      },
      runner,
      { buildOutputExists: () => true },
    );

    expect(result.publish).toEqual({
      nhash: 'nhash1ace',
      publishedRef: 'npub1example/video',
    });
    expect(result.workerName).toBe('iris-video');
    expect(result.pagesProject).toBeNull();
    expect(result.pagesUrl).toBeNull();
  });

  it('returns parsed hashtree and Pages URLs on success', async () => {
    const runner = vi.fn((step) => {
      if (step.id === 'publish') {
        return {
          status: 0,
          stdout: 'published: npub1example/video\nnhash1ace',
          stderr: '',
        };
      }
      if (step.id === 'deploy') {
        return {
          status: 0,
          stdout: 'Deploying... https://video-iris-to.pages.dev',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = await runRelease(
      {
        profileName: 'video',
        pagesProject: 'video-iris-to',
        treeName: 'video',
        skipCloudflare: false,
      },
      runner,
      { buildOutputExists: () => true },
    );

    expect(result.publish).toEqual({
      nhash: 'nhash1ace',
      publishedRef: 'npub1example/video',
    });
    expect(result.pagesUrl).toBe('https://video-iris-to.pages.dev');
  });

  it('runs all profiles sequentially', async () => {
    const runner = vi.fn((step) => {
      if (step.id === 'publish') {
        return {
          status: 0,
          stdout: `published: npub1example/${step.label.split(' ')[1].toLowerCase()}\nnhash1ace`,
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = await runAllReleases(
      {
        profileName: 'all',
        skipCloudflare: true,
      },
      runner,
      { buildOutputExists: () => true },
    );

    expect(result.profiles).toHaveLength(6);
    expect(result.profiles.map((profile) => profile.profile.name)).toEqual([
      'files',
      'video',
      'docs',
      'git',
      'maps',
      'boards',
    ]);
  });

  it('parses htree publish output defensively', () => {
    expect(parsePublishOutput('published: npub1foo/files\nnhash1ace')).toEqual({
      nhash: 'nhash1ace',
      publishedRef: 'npub1foo/files',
    });
    expect(
      parsePublishOutput(
        [
          '2026-03-19T21:46:47Z ERROR nostr_relay_pool::pool::internal: Impossible to send event to wss://upload.iris.to/nostr: event not published: index build failed: MissingChunk',
          'published: npub1foo/files',
          'nhash1ace',
        ].join('\n'),
      ),
    ).toEqual({
      nhash: 'nhash1ace',
      publishedRef: 'npub1foo/files',
    });
    expect(() => parsePublishOutput('published: npub1foo/files')).toThrow(
      'Publish succeeded but no nhash was found in htree output',
    );
  });
});
