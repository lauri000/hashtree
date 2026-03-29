import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import {
  collectReleaseAssetPaths,
  defaultSharedWindowsRepoPath,
  packagingConfigPath,
  parseArgs,
  usage,
  windowsArtifactArch,
  workspaceInstallCommands,
} from '../scripts/local-release.mjs'

test('parseArgs accepts tag normalization and step filters', () => {
  const parsed = parseArgs([
    '--tag',
    '0.2.14',
    '--only',
    'macos,windows',
    '--skip',
    'verify',
    '--release-tree',
    'releases/hashtree',
    '--publish',
  ])

  assert.equal(parsed.tag, 'v0.2.14')
  assert.equal(parsed.publish, true)
  assert.equal(parsed.releaseTree, 'releases/hashtree')
  assert.deepEqual([...parsed.only], ['macos', 'windows'])
  assert.deepEqual([...parsed.skip], ['verify'])
})

test('parseArgs ignores a leading script separator', () => {
  const parsed = parseArgs(['--', '--dry-run', '--only', 'windows'])
  assert.equal(parsed.dryRun, true)
  assert.deepEqual([...parsed.only], ['windows'])
})

test('collectReleaseAssetPaths only picks assets for one release prefix', () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), 'iris-release-assets-'))
  try {
    writeFileSync(join(tempDir, 'iris-v0.2.14-macos-arm64.zip'), 'a')
    writeFileSync(join(tempDir, 'iris-v0.2.14-windows-x64-setup.exe'), 'b')
    writeFileSync(join(tempDir, 'iris-v0.2.13-macos-arm64.zip'), 'c')
    writeFileSync(join(tempDir, 'notes.txt'), 'd')

    const assets = collectReleaseAssetPaths('iris-v0.2.14', tempDir)
    assert.deepEqual(
      assets.map((asset) => asset.split('/').at(-1)),
      ['iris-v0.2.14-macos-arm64.zip', 'iris-v0.2.14-windows-x64-setup.exe'],
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('windowsArtifactArch maps common Windows target triples', () => {
  assert.equal(windowsArtifactArch('x86_64-pc-windows-msvc'), 'x64')
  assert.equal(windowsArtifactArch('aarch64-pc-windows-msvc'), 'arm64')
})

test('defaultSharedWindowsRepoPath derives the shared Parallels path on mac-style workspaces', () => {
  const homeDir = os.homedir()
  const path = defaultSharedWindowsRepoPath(join(homeDir, 'src', 'hashtree'))
  if (process.platform === 'darwin') {
    assert.equal(path, 'C:\\Mac\\Home\\src\\hashtree')
  } else {
    assert.equal(path, null)
  }
})

test('usage mentions explicit release-tree requirement for publish', () => {
  assert.match(usage(), /--publish requires an explicit --release-tree/)
})

test('workspaceInstallCommands bootstraps iris-files before iris', () => {
  assert.deepEqual(workspaceInstallCommands('pnpm'), [
    'pnpm --dir apps/iris-files install --frozen-lockfile --ignore-scripts',
    'pnpm --dir apps/iris install --frozen-lockfile --ignore-scripts',
  ])
})

test('packagingConfigPath points at the no-frontend Tauri override', () => {
  assert.equal(packagingConfigPath(), 'src-tauri/tauri.release.no-frontend.json')
})
