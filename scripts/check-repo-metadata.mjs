import fs from 'node:fs';
import path from 'node:path';

const REPO_URL = 'https://git.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree';
const BUGS_URL = `${REPO_URL}?tab=issues`;

const expectedJsonMetadata = new Map([
  ['ts/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/ts`, bugs: BUGS_URL }],
  ['apps/hashtree-cc/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/apps/hashtree-cc`, bugs: BUGS_URL }],
  ['apps/iris-files/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/apps/iris-files`, bugs: BUGS_URL }],
  ['apps/iris/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/apps/iris`, bugs: BUGS_URL }],
  ['ts/packages/hashtree/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/ts/packages/hashtree`, bugs: BUGS_URL }],
  ['ts/packages/hashtree-dexie/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/ts/packages/hashtree-dexie`, bugs: BUGS_URL }],
  ['ts/packages/hashtree-git/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/ts/packages/hashtree-git`, bugs: BUGS_URL }],
  ['ts/packages/hashtree-index/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/ts/packages/hashtree-index`, bugs: BUGS_URL }],
  ['ts/packages/hashtree-nostr/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/ts/packages/hashtree-nostr`, bugs: BUGS_URL }],
  ['ts/packages/hashtree-tree-root/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/ts/packages/hashtree-tree-root`, bugs: BUGS_URL }],
  ['ts/packages/hashtree-worker/package.json', { repository: REPO_URL, homepage: `${REPO_URL}/ts/packages/hashtree-worker`, bugs: BUGS_URL }],
]);

const requiredReadmes = [
  'README.md',
  'ts/README.md',
  'rust/README.md',
];

const errors = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    errors.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

for (const file of requiredReadmes) {
  if (!fs.existsSync(path.resolve(file))) {
    errors.push(`${file}: missing README`);
  }
}

for (const [file, expected] of expectedJsonMetadata.entries()) {
  const manifest = readJson(file);
  expectEqual(manifest.repository, expected.repository, `${file} repository`);
  expectEqual(manifest.homepage, expected.homepage, `${file} homepage`);
  expectEqual(manifest.bugs?.url, expected.bugs, `${file} bugs.url`);
}

const rustWorkspace = fs.readFileSync(path.resolve('rust/Cargo.toml'), 'utf8');
if (!rustWorkspace.includes(`repository = "${REPO_URL}"`)) {
  errors.push('rust/Cargo.toml: workspace repository does not match hashtree repo URL');
}
if (!rustWorkspace.includes(`homepage = "${REPO_URL}"`)) {
  errors.push('rust/Cargo.toml: workspace homepage does not match hashtree repo URL');
}

for (const entry of fs.readdirSync(path.resolve('rust/crates'), { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }

  const dir = path.join('rust/crates', entry.name);
  const cargoPath = path.join(dir, 'Cargo.toml');
  if (!fs.existsSync(path.resolve(cargoPath))) {
    continue;
  }

  const cargo = fs.readFileSync(path.resolve(cargoPath), 'utf8');
  if (!cargo.includes('repository.workspace = true')) {
    errors.push(`${cargoPath}: missing repository.workspace = true`);
  }
  if (!cargo.includes('homepage.workspace = true')) {
    errors.push(`${cargoPath}: missing homepage.workspace = true`);
  }
  if (!cargo.includes('authors.workspace = true')) {
    errors.push(`${cargoPath}: missing authors.workspace = true`);
  }
  if (!fs.existsSync(path.resolve(dir, 'README.md'))) {
    errors.push(`${dir}/README.md: missing crate README`);
  }
}

const irisTauriCargo = fs.readFileSync(path.resolve('apps/iris/src-tauri/Cargo.toml'), 'utf8');
if (!irisTauriCargo.includes(`repository = "${REPO_URL}"`)) {
  errors.push('apps/iris/src-tauri/Cargo.toml: repository does not match hashtree repo URL');
}
if (!irisTauriCargo.includes(`homepage = "${REPO_URL}/apps/iris"`)) {
  errors.push('apps/iris/src-tauri/Cargo.toml: missing homepage for the Iris app');
}

if (errors.length > 0) {
  console.error('Repository metadata check failed:\n');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Repository metadata looks consistent.');
