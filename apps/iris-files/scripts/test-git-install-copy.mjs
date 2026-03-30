import { readFileSync } from 'node:fs';

import {
  GIT_REMOTE_HTREE_INSTALL_COMMAND,
  GIT_REMOTE_HTREE_INSTALL_DOCS_URL,
} from '../src/components/Git/codeDropdownCopy.js';

const checks = [
  {
    label: 'root README install section',
    path: new URL('../../../README.md', import.meta.url),
    mustInclude: [
      GIT_REMOTE_HTREE_INSTALL_COMMAND,
    ],
  },
  {
    label: 'git-remote-htree README install section',
    path: new URL('../../../rust/crates/git-remote-htree/README.md', import.meta.url),
    mustInclude: [
      GIT_REMOTE_HTREE_INSTALL_COMMAND,
    ],
  },
  {
    label: 'hashtree.cc developers install section',
    path: new URL('../../../apps/hashtree-cc/src/components/Developers.svelte', import.meta.url),
    mustInclude: [
      GIT_REMOTE_HTREE_INSTALL_COMMAND,
    ],
  },
  {
    label: 'Code dropdown docs link',
    path: new URL('../src/components/Git/codeDropdownCopy.js', import.meta.url),
    mustInclude: [
      GIT_REMOTE_HTREE_INSTALL_DOCS_URL,
    ],
  },
];

let failed = false;

for (const check of checks) {
  const content = readFileSync(check.path, 'utf8');
  for (const needle of check.mustInclude) {
    if (!content.includes(needle)) {
      console.error(`[git-install-copy] Missing ${JSON.stringify(needle)} in ${check.label}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log('[git-install-copy] Install copy is aligned across UI and README docs.');
