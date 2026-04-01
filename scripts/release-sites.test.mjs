import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createReleaseCommands, parseArgs } from './release-sites.mjs';

const expectedIrisAppsRepoRoot = path.resolve(import.meta.dirname, '..', '..', 'iris-apps');
const expectedHashtreeCcRepoRoot = path.resolve(import.meta.dirname, '..', '..', 'hashtree-cc');

test('builds repo-wide release commands for iris files and hashtree.cc', () => {
  const commands = createReleaseCommands({
    skipCloudflare: false,
    dryRun: false,
  });

  assert.deepEqual(
    commands.map((command) => ({ args: command.args, cwd: command.cwd })),
    [
      {
        args: ['apps/iris-files/scripts/release-site.mjs', 'all'],
        cwd: expectedIrisAppsRepoRoot,
      },
      {
        args: ['apps/hashtree-cc/scripts/release-site.mjs'],
        cwd: expectedHashtreeCcRepoRoot,
      },
    ],
  );
});

test('propagates shared dry-run and skip-cloudflare flags to both release commands', () => {
  const parsed = parseArgs(['--skip-cloudflare', '--dry-run', '--compatibility-date', '2026-03-19']);
  const commands = createReleaseCommands(parsed);

  assert.deepEqual(
    commands.map((command) => ({ args: command.args, cwd: command.cwd })),
    [
      {
        args: [
          'apps/iris-files/scripts/release-site.mjs',
          'all',
          '--skip-cloudflare',
          '--dry-run',
          '--compatibility-date',
          '2026-03-19',
        ],
        cwd: expectedIrisAppsRepoRoot,
      },
      {
        args: [
          'apps/hashtree-cc/scripts/release-site.mjs',
          '--skip-cloudflare',
          '--dry-run',
          '--compatibility-date',
          '2026-03-19',
        ],
        cwd: expectedHashtreeCcRepoRoot,
      },
    ],
  );
});
