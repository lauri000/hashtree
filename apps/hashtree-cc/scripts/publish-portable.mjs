import path from 'node:path';
import { spawnSync } from 'node:child_process';

const appDir = path.resolve(import.meta.dirname, '..');
const distDir = path.join(appDir, 'dist');
const repoRoot = path.resolve(appDir, '..', '..');
const manifestPath = path.join(repoRoot, 'rust', 'Cargo.toml');

const result = spawnSync(
  'cargo',
  ['run', '--manifest-path', manifestPath, '-p', 'hashtree-cli', '--bin', 'htree', '--', 'add', '.', '--publish', 'hashtree-cc'],
  {
    cwd: distDir,
    encoding: 'utf8',
    stdio: 'pipe',
  },
);

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const output = `${result.stdout}\n${result.stderr}`;
const nhashMatch = output.match(/nhash1[ac-hj-np-z02-9]+/i);
if (!nhashMatch) {
  console.error('Publish succeeded but no nhash was found in htree output');
  process.exit(1);
}
const publishedMatch = output.match(/^\s*published:\s+(\S+)\s*$/im);
if (!publishedMatch) {
  console.error('Publish succeeded but no mutable ref was found in htree output');
  process.exit(1);
}

console.log(`Portable hashtree.cc immutable URL: htree://${nhashMatch[0]}/index.html`);
console.log(`Portable hashtree.cc mutable URL: htree://${publishedMatch[1]}`);
console.log(`Portable hashtree.cc owner URL: htree://${publishedMatch[1]}`);
