import test from 'node:test';
import assert from 'node:assert/strict';

import { createReleasePlan, parseArgs, parsePublishOutput, runRelease } from '../scripts/release-site.mjs';

test('uses the built-in Worker default for hashtree.cc', () => {
  const parsed = parseArgs([]);

  assert.equal(parsed.workerName, 'hashtree-cc');
  assert.equal(parsed.treeName, 'hashtree-cc');
  assert.deepEqual(parsed.routes, []);
  assert.deepEqual(parsed.domains, []);
});

test('supports switching hashtree.cc releases back to Pages explicitly', () => {
  const parsed = parseArgs(['--pages-only'], { CF_PAGES_PROJECT_HASHTREE_CC: 'hashtree-cc' });

  assert.equal(parsed.workerName, undefined);
  assert.equal(parsed.pagesProject, 'hashtree-cc');
  assert.deepEqual(parsed.routes, []);
  assert.deepEqual(parsed.domains, []);
});

test('builds a Worker release plan in build-test-publish-deploy order', () => {
  const plan = createReleasePlan({
    workerName: 'hashtree-cc',
    treeName: 'hashtree-cc',
    routes: [],
    domains: [],
    skipCloudflare: false,
    workerCompatibilityDate: '2026-03-19',
  });

  assert.deepEqual(
    plan.steps.map((step) => step.id),
    ['build', 'test-1', 'test-2', 'publish', 'deploy'],
  );
  assert.deepEqual(plan.steps.at(-1)?.command, [
    'npx',
    'wrangler@4',
    'deploy',
    '--assets',
    'dist',
    '--name',
    'hashtree-cc',
    '--compatibility-date',
    '2026-03-19',
    '--keep-vars',
  ]);
});

test('adds explicit routes and domains to the Worker deploy command', () => {
  const plan = createReleasePlan({
    workerName: 'hashtree-cc',
    treeName: 'hashtree-cc',
    routes: ['hashtree.cc/*'],
    domains: ['hashtree.cc'],
    skipCloudflare: false,
    workerCompatibilityDate: '2026-03-19',
  });

  assert.deepEqual(plan.steps.at(-1)?.command, [
    'npx',
    'wrangler@4',
    'deploy',
    '--assets',
    'dist',
    '--name',
    'hashtree-cc',
    '--compatibility-date',
    '2026-03-19',
    '--keep-vars',
    '--route',
    'hashtree.cc/*',
    '--domain',
    'hashtree.cc',
  ]);
});

test('runs hashtree publish and Worker deploy in parallel after tests', async () => {
  let activeReleaseSteps = 0;
  let maxActiveReleaseSteps = 0;
  const calls = [];

  await runRelease(
    {
      workerName: 'hashtree-cc',
      treeName: 'hashtree-cc',
      routes: [],
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
            stdout: 'published: npub1example/hashtree-cc\nnhash1ace',
            stderr: '',
          };
        }
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    { buildOutputExists: () => true },
  );

  assert.deepEqual(calls, ['build', 'test-1', 'test-2', 'publish', 'deploy']);
  assert.equal(maxActiveReleaseSteps, 2);
});

test('returns parsed hashtree publish data and Worker target on success', async () => {
  const result = await runRelease(
    {
      workerName: 'hashtree-cc',
      treeName: 'hashtree-cc',
      routes: [],
      domains: [],
      skipCloudflare: false,
      workerCompatibilityDate: '2026-03-19',
    },
    (step) => {
      if (step.id === 'publish') {
        return {
          status: 0,
          stdout: 'published: npub1example/hashtree-cc\nnhash1ace',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    { buildOutputExists: () => true },
  );

  assert.deepEqual(result.publish, {
    nhash: 'nhash1ace',
    publishedRef: 'npub1example/hashtree-cc',
  });
  assert.equal(result.workerName, 'hashtree-cc');
  assert.equal(result.pagesProject, null);
});

test('parses htree publish output defensively', () => {
  assert.deepEqual(parsePublishOutput('published: npub1foo/hashtree-cc\nnhash1ace'), {
    nhash: 'nhash1ace',
    publishedRef: 'npub1foo/hashtree-cc',
  });
  assert.throws(
    () => parsePublishOutput('published: npub1foo/hashtree-cc'),
    /Publish succeeded but no nhash was found in htree output/,
  );
});
