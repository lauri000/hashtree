import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { parseArgs, stageRepoRelease } from './stage_repo_release.mjs'

test('parseArgs accepts optional Iris staging inputs', () => {
  const parsed = parseArgs([
    '--tag',
    'v0.2.16',
    '--commit',
    'abc123',
    '--cli-dir',
    '/tmp/cli',
    '--output-dir',
    '/tmp/out',
    '--iris-stage-dir',
    '/tmp/iris',
    '--install-url',
    'https://upload.example/releases%2Fhashtree/latest/install.sh',
    '--title',
    'v0.2.16',
  ])

  assert.equal(parsed.tag, 'v0.2.16')
  assert.equal(parsed.commit, 'abc123')
  assert.equal(parsed.cliDir, '/tmp/cli')
  assert.equal(parsed.outputDir, '/tmp/out')
  assert.equal(parsed.irisStageDir, '/tmp/iris')
  assert.equal(parsed.installUrl, 'https://upload.example/releases%2Fhashtree/latest/install.sh')
  assert.equal(parsed.title, 'v0.2.16')
})

test('stageRepoRelease creates a metadata-backed repo release directory', () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), 'stage-repo-release-'))

  try {
    const cliDir = join(tempDir, 'cli')
    const irisStageDir = join(tempDir, 'iris-stage')
    const outputDir = join(tempDir, 'out')

    mkdirSync(cliDir, { recursive: true })
    mkdirSync(join(irisStageDir, 'assets'), { recursive: true })

    writeFileSync(join(cliDir, 'install.sh'), '#!/bin/sh\necho install\n')
    writeFileSync(join(cliDir, 'hashtree-aarch64-apple-darwin.tar.gz'), 'cli-tar')
    writeFileSync(join(cliDir, 'hashtree-aarch64-apple-darwin.sha256'), 'cli-sha')
    writeFileSync(join(irisStageDir, 'assets', 'iris-v0.2.16-macos-arm64.zip'), 'iris-zip')
    writeFileSync(join(irisStageDir, 'assets', 'iris-v0.2.16-windows-x64-setup.exe'), 'iris-exe')

    const result = stageRepoRelease({
      tag: 'v0.2.16',
      commit: 'abc123',
      cliDir,
      outputDir,
      irisStageDir,
      installUrl: 'https://upload.example/releases%2Fhashtree/latest/install.sh',
    })

    assert.equal(result.assetCount, 5)
    assert.equal(existsSync(join(outputDir, 'release.json')), true)
    assert.equal(existsSync(join(outputDir, 'notes.md')), true)
    assert.equal(existsSync(join(outputDir, 'install.sh')), true)
    assert.equal(existsSync(join(outputDir, 'assets', 'hashtree-aarch64-apple-darwin.tar.gz')), true)
    assert.equal(existsSync(join(outputDir, 'assets', 'iris-v0.2.16-macos-arm64.zip')), true)

    const manifest = JSON.parse(readFileSync(join(outputDir, 'release.json'), 'utf8'))
    assert.deepEqual(
      manifest.assets.map((asset) => asset.path),
      [
        'assets/hashtree-aarch64-apple-darwin.sha256',
        'assets/hashtree-aarch64-apple-darwin.tar.gz',
        'install.sh',
        'assets/iris-v0.2.16-macos-arm64.zip',
        'assets/iris-v0.2.16-windows-x64-setup.exe',
      ],
    )

    const notes = readFileSync(join(outputDir, 'notes.md'), 'utf8')
    assert.match(notes, /curl -fsSL https:\/\/upload\.example\/releases%2Fhashtree\/latest\/install\.sh \| sh/)
    assert.match(notes, /Install with shell:/)
    assert.match(notes, /Manual install: download the archive for your platform from the release assets below/)
    assert.match(notes, /Iris Desktop App/)
    assert.match(notes, /download the macOS app archive below/)
    assert.match(notes, /Includes Iris desktop release assets\./)
    assert.doesNotMatch(notes, /## Downloads/)
    assert.doesNotMatch(notes, /hashtree-aarch64-apple-darwin\.sha256/)
    assert.doesNotMatch(notes, /hashtree-aarch64-apple-darwin\.tar\.gz/)
    assert.doesNotMatch(notes, /iris-v0.2.16-macos-arm64\.zip/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
