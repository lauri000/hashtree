import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const distIndexPath = resolve(import.meta.dirname, '..', 'dist', 'index.html');
const distAssetsPath = resolve(import.meta.dirname, '..', 'dist', 'assets');
const installCommand =
  'curl -fsSL https://upload.iris.to/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/releases%2Fhashtree/latest/install.sh | sh';
const legacyGithubInstallPattern = 'https://github.com/mmalmi/hashtree/releases/latest/download/';

test('portable hashtree.cc build uses relative asset URLs', () => {
  const html = readFileSync(distIndexPath, 'utf8');

  assert(!html.includes('src="/assets/'), 'expected script asset path to be relative');
  assert(!html.includes('href="/assets/'), 'expected stylesheet asset path to be relative');
  assert(!html.includes('href="/manifest.webmanifest"'), 'expected manifest path to be relative');
  assert(!html.includes('crossorigin'), 'expected crossorigin hints to be stripped for htree delivery');
  assert(!html.includes('modulepreload'), 'expected modulepreload hints to be stripped for htree delivery');
});

test('portable hashtree.cc build ships the canonical install command', () => {
  const bundle = readdirSync(distAssetsPath)
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => readFileSync(resolve(distAssetsPath, entry), 'utf8'))
    .join('\n');

  assert(bundle.includes(installCommand), 'expected built bundle to contain the install.sh bootstrap command');
  assert(!bundle.includes(legacyGithubInstallPattern), 'expected built bundle to avoid the legacy GitHub release download command');
});
