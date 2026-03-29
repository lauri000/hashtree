import { describe, expect, it } from 'vitest';
import { createReleasePlan, parseArgs, runRelease } from '../scripts/release-site.mjs';

describe('iris-sites release-site', () => {
  it('uses the built-in Worker default and production routes for sites', () => {
    const parsed = parseArgs([]);

    expect(parsed.workerName).toBe('iris-sites');
    expect(parsed.treeName).toBe('sites');
    expect(parsed.routes).toEqual([
      'sites.iris.to/*',
      '*.hashtree.cc/*',
    ]);
  });

  it('drops production routes when a custom Worker name is used', () => {
    const parsed = parseArgs(['--worker-name', 'iris-sites-preview']);

    expect(parsed.workerName).toBe('iris-sites-preview');
    expect(parsed.routes).toEqual([]);
  });

  it('builds a Worker release plan in build-test-publish-deploy order', () => {
    const plan = createReleasePlan({
      workerName: 'iris-sites',
      treeName: 'sites',
      routes: ['sites.iris.to/*', '*.hashtree.cc/*'],
      skipCloudflare: false,
      workerCompatibilityDate: '2026-03-19',
    });

    expect(plan.steps.map((step) => step.id)).toEqual([
      'build',
      'test-1',
      'test-2',
      'test-3',
      'publish',
      'deploy',
    ]);
    expect(plan.steps.at(-1)?.command).toEqual([
      'npx',
      'wrangler@4',
      'deploy',
      '--assets',
      'dist',
      '--name',
      'iris-sites',
      '--compatibility-date',
      '2026-03-19',
      '--keep-vars',
      '--route',
      'sites.iris.to/*',
      '--route',
      '*.hashtree.cc/*',
    ]);
  });

  it('runs hashtree publish and Worker deploy in parallel after tests', async () => {
    let activeReleaseSteps = 0;
    let maxActiveReleaseSteps = 0;
    const calls: string[] = [];

    await runRelease(
      {
        workerName: 'iris-sites',
        treeName: 'sites',
        routes: ['sites.iris.to/*', '*.hashtree.cc/*'],
        domains: [],
        skipCloudflare: false,
        workerCompatibilityDate: '2026-03-19',
      },
      async (step) => {
        calls.push(step.id);
        if (step.id === 'publish' || step.id === 'deploy') {
          activeReleaseSteps += 1;
          maxActiveReleaseSteps = Math.max(maxActiveReleaseSteps, activeReleaseSteps);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeReleaseSteps -= 1;
          if (step.id === 'publish') {
            return {
              status: 0,
              stdout: 'published: npub1example/sites\nnhash1ace',
              stderr: '',
            };
          }
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      { buildOutputExists: () => true },
    );

    expect(calls).toEqual(['build', 'test-1', 'test-2', 'test-3', 'publish', 'deploy']);
    expect(maxActiveReleaseSteps).toBe(2);
  });
});
