import test from 'node:test';
import assert from 'node:assert/strict';

import { createReleaseCommands, parseArgs } from './release-sites.mjs';

test('builds repo-wide release commands for iris files and hashtree.cc', () => {
  const commands = createReleaseCommands({
    skipCloudflare: false,
    dryRun: false,
  });

  assert.deepEqual(
    commands.map((command) => command.args),
    [
      ['apps/iris-files/scripts/release-site.mjs', 'all'],
      ['apps/hashtree-cc/scripts/release-site.mjs'],
    ],
  );
});

test('propagates shared dry-run and skip-cloudflare flags to both release commands', () => {
  const parsed = parseArgs(['--skip-cloudflare', '--dry-run', '--compatibility-date', '2026-03-19']);
  const commands = createReleaseCommands(parsed);

  assert.deepEqual(
    commands.map((command) => command.args),
    [
      [
        'apps/iris-files/scripts/release-site.mjs',
        'all',
        '--skip-cloudflare',
        '--dry-run',
        '--compatibility-date',
        '2026-03-19',
      ],
      [
        'apps/hashtree-cc/scripts/release-site.mjs',
        '--skip-cloudflare',
        '--dry-run',
        '--compatibility-date',
        '2026-03-19',
      ],
    ],
  );
});
