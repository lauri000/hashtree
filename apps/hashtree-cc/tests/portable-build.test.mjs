import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const distIndexPath = resolve(import.meta.dirname, '..', 'dist', 'index.html');

test('portable hashtree.cc build uses relative asset URLs', () => {
  const html = readFileSync(distIndexPath, 'utf8');

  assert(!html.includes('src="/assets/'), 'expected script asset path to be relative');
  assert(!html.includes('href="/assets/'), 'expected stylesheet asset path to be relative');
  assert(!html.includes('href="/manifest.webmanifest"'), 'expected manifest path to be relative');
  assert(!html.includes('crossorigin'), 'expected crossorigin hints to be stripped for htree delivery');
  assert(!html.includes('modulepreload'), 'expected modulepreload hints to be stripped for htree delivery');
});
