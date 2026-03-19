import { describe, expect, it, vi } from 'vitest';
import { createReleasePlan, parseArgs, parsePublishOutput, runRelease } from '../scripts/release-site.mjs';

describe('release-site', () => {
  it('uses the profile-specific Pages project env var by default', () => {
    const parsed = parseArgs(['video'], { CF_PAGES_PROJECT_VIDEO: 'video-iris-to' });
    expect(parsed.pagesProject).toBe('video-iris-to');
    expect(parsed.treeName).toBe('video');
  });

  it('supports docs, maps, and boards release profiles', () => {
    const docs = createReleasePlan({
      profileName: 'docs',
      pagesProject: 'docs-iris-to',
      treeName: 'docs',
      skipPages: false,
    });
    const maps = createReleasePlan({
      profileName: 'maps',
      pagesProject: 'maps-iris-to',
      treeName: 'maps',
      skipPages: false,
    });
    const boards = createReleasePlan({
      profileName: 'boards',
      pagesProject: 'boards-iris-to',
      treeName: 'boards',
      skipPages: false,
    });

    expect(docs.profile.distDir).toBe('dist-docs');
    expect(maps.profile.distDir).toBe('dist-maps');
    expect(boards.profile.distDir).toBe('dist-boards');
  });

  it('builds the release plan in build-test-publish-deploy order', () => {
    const plan = createReleasePlan({
      profileName: 'files',
      pagesProject: 'files-iris-to',
      treeName: 'files',
      branch: 'main',
      skipPages: false,
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
      'wrangler',
      'pages',
      'deploy',
      'dist',
      '--project-name',
      'files-iris-to',
      '--branch',
      'main',
    ]);
  });

  it('stops before publish when a test step fails', () => {
    const calls = [];
    const runner = vi.fn((step) => {
      calls.push(step.id);
      if (step.id === 'test-2') {
        return { status: 1, stdout: '', stderr: 'smoke failed' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    expect(() =>
      runRelease(
        {
          profileName: 'video',
          pagesProject: 'video-iris-to',
          treeName: 'video',
          skipPages: false,
        },
        runner,
        { buildOutputExists: () => true },
      ),
    ).toThrow('Test Iris Video (2/2) failed with exit code 1');
    expect(calls).toEqual(['build', 'test-1', 'test-2']);
  });

  it('returns parsed hashtree and Pages URLs on success', () => {
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

    const result = runRelease(
        {
          profileName: 'video',
          pagesProject: 'video-iris-to',
          treeName: 'video',
          skipPages: false,
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

  it('parses htree publish output defensively', () => {
    expect(parsePublishOutput('published: npub1foo/files\nnhash1ace')).toEqual({
      nhash: 'nhash1ace',
      publishedRef: 'npub1foo/files',
    });
    expect(() => parsePublishOutput('published: npub1foo/files')).toThrow(
      'Publish succeeded but no nhash was found in htree output',
    );
  });
});
