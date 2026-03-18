import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const distDir = path.join(appDir, 'dist-video-iris');
const repoRoot = path.resolve(appDir, '..', '..');
const manifestPath = path.join(repoRoot, 'rust', 'Cargo.toml');

const result = spawnSync(
  'cargo',
  ['run', '--manifest-path', manifestPath, '-p', 'hashtree-cli', '--bin', 'htree', '--', 'add', '.', '--public'],
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
const match = output.match(/nhash1[ac-hj-np-z02-9]+/i);
if (!match) {
  console.error('Publish succeeded but no nhash was found in htree output');
  process.exit(1);
}

console.log(`Portable Iris video URL: htree://${match[0]}/index.html`);
