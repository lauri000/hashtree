import { describe, expect, it } from 'vitest';
import { createReleasePlan, parseArgs } from '../scripts/release-site.mjs';

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
});
