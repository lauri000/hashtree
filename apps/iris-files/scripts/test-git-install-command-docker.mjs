import { spawnSync } from 'node:child_process';

import { GIT_REMOTE_HTREE_INSTALL_COMMAND } from '../src/components/Git/codeDropdownCopy.js';

const image = process.env.HTREE_INSTALL_TEST_IMAGE ?? 'rust:1-bookworm';
const command = `${GIT_REMOTE_HTREE_INSTALL_COMMAND} && command -v htree >/dev/null && command -v git-remote-htree >/dev/null`;

console.log(`[git-install-docker] Testing install command in ${image}`);
console.log(`[git-install-docker] ${command}`);

const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    image,
    'bash',
    '-o',
    'pipefail',
    '-lc',
    command,
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('[git-install-docker] Install command succeeded in a clean Linux container.');
