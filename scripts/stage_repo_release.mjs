#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

function usage() {
  return `Usage: node scripts/stage_repo_release.mjs --tag <tag> --commit <commit> --cli-dir <dir> --output-dir <dir> [options]

Stage a repo release directory containing release.json, notes.md, a root install.sh,
and an assets/ directory suitable for publishing into releases/<repo>.

Options:
  --tag <tag>               Release tag (for example: v0.2.16)
  --commit <sha>            Commit hash for release.json metadata
  --cli-dir <dir>           Directory containing CLI release assets
  --output-dir <dir>        Staged release directory to create
  --iris-stage-dir <dir>    Optional staged Iris release directory
  --install-url <url>       Optional bootstrap install URL to include in notes
  --title <title>           Optional release title (defaults to <tag>)
  -h, --help                Show this help
`
}

export function parseArgs(argv) {
  const args = [...argv]
  const options = {
    tag: '',
    commit: '',
    cliDir: '',
    outputDir: '',
    irisStageDir: '',
    installUrl: '',
    title: '',
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    switch (arg) {
      case '--tag':
        options.tag = args[++index] ?? ''
        break
      case '--commit':
        options.commit = args[++index] ?? ''
        break
      case '--cli-dir':
        options.cliDir = resolve(args[++index] ?? '')
        break
      case '--output-dir':
        options.outputDir = resolve(args[++index] ?? '')
        break
      case '--iris-stage-dir':
        options.irisStageDir = resolve(args[++index] ?? '')
        break
      case '--install-url':
        options.installUrl = args[++index] ?? ''
        break
      case '--title':
        options.title = args[++index] ?? ''
        break
      case '--help':
      case '-h':
        return { help: true }
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function listTopLevelFiles(root) {
  if (!root || !existsSync(root)) {
    return []
  }

  return readdirSync(root)
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => join(root, entry))
    .filter((fullPath) => statSync(fullPath).isFile())
}

function buildCliAssetEntries(cliDir) {
  if (!cliDir) {
    throw new Error('Missing --cli-dir')
  }

  return listTopLevelFiles(cliDir)
    .filter((fullPath) => {
      const name = basename(fullPath)
      return name !== 'release.json' && name !== 'notes.md'
    })
    .map((sourcePath) => {
      const name = basename(sourcePath)
      return {
        name,
        sourcePath,
        relativePath: name === 'install.sh' ? 'install.sh' : `assets/${name}`,
      }
    })
}

function buildIrisAssetEntries(irisStageDir) {
  if (!irisStageDir) {
    return []
  }

  const assetsDir = join(irisStageDir, 'assets')
  return listTopLevelFiles(assetsDir).map((sourcePath) => ({
    name: basename(sourcePath),
    sourcePath,
    relativePath: `assets/${basename(sourcePath)}`,
  }))
}

function classifyAssetNames(assetNames) {
  const find = (pattern) =>
    [...assetNames].sort((left, right) => left.localeCompare(right)).find((name) => pattern.test(name))

  return {
    installSh: assetNames.includes('install.sh') ? 'install.sh' : undefined,
    cliMacArm64: find(/^hashtree-aarch64-apple-darwin\.tar\.gz$/),
    cliMacX64: find(/^hashtree-x86_64-apple-darwin\.tar\.gz$/),
    cliLinuxX64: find(/^hashtree-x86_64-unknown-linux-musl\.tar\.gz$/),
    cliLinuxArm64: find(/^hashtree-aarch64-unknown-linux-musl\.tar\.gz$/),
    cliWindowsX64: find(/^hashtree-x86_64-pc-windows-msvc\.zip$/),
    irisMacArm64: find(/^iris-.*-macos-arm64\.zip$/),
    irisLinuxAppImage: find(/^iris-.*-linux-x86_64\.AppImage$/),
    irisLinuxDeb: find(/^iris-.*-linux-x86_64\.deb$/),
    irisWindowsX64: find(/^iris-.*-windows-x64-setup\.exe$/),
  }
}

export function renderReleaseNotes({ tag, commit, assetEntries, installUrl = '' }) {
  const assetNames = assetEntries.map((entry) => entry.name)
  const assets = classifyAssetNames(assetNames)
  const lines = ['## Installation', '']

  lines.push('### htree CLI', '')
  if (installUrl && assets.installSh) {
    lines.push('Auto-detect install:', '', '```bash', `curl -fsSL ${installUrl} | sh`, '```', '')
  } else if (assets.installSh) {
    lines.push('Bootstrap installer: `install.sh`', '')
  }

  if (
    assets.cliMacArm64 ||
    assets.cliMacX64 ||
    assets.cliLinuxX64 ||
    assets.cliLinuxArm64 ||
    assets.cliWindowsX64
  ) {
    lines.push('Manual downloads:', '')
    if (assets.cliMacArm64 || assets.cliMacX64) {
      lines.push('macOS:')
      if (assets.cliMacArm64) {
        lines.push(`- Apple Silicon: \`${assets.cliMacArm64}\``)
      }
      if (assets.cliMacX64) {
        lines.push(`- Intel: \`${assets.cliMacX64}\``)
      }
    }
    if (assets.cliLinuxX64 || assets.cliLinuxArm64) {
      lines.push('Linux:')
      if (assets.cliLinuxX64) {
        lines.push(`- x86_64: \`${assets.cliLinuxX64}\``)
      }
      if (assets.cliLinuxArm64) {
        lines.push(`- ARM64: \`${assets.cliLinuxArm64}\``)
      }
    }
    if (assets.cliWindowsX64) {
      lines.push('Windows:')
      lines.push(`- \`${assets.cliWindowsX64}\``)
    }
    lines.push('')
  }

  if (
    assets.irisMacArm64 ||
    assets.irisLinuxAppImage ||
    assets.irisLinuxDeb ||
    assets.irisWindowsX64
  ) {
    lines.push('### Iris Desktop App', '')
    if (assets.irisMacArm64) {
      lines.push(`- macOS: download \`${assets.irisMacArm64}\`, unzip it, and move \`Iris.app\` into \`/Applications\`.`)
    }
    if (assets.irisLinuxAppImage) {
      lines.push(`- Linux AppImage: run \`chmod +x ${assets.irisLinuxAppImage} && ./${assets.irisLinuxAppImage}\`.`)
    }
    if (assets.irisLinuxDeb) {
      lines.push(`- Linux .deb: install \`${assets.irisLinuxDeb}\` with \`sudo apt install ./${assets.irisLinuxDeb}\`.`)
    }
    if (assets.irisWindowsX64) {
      lines.push(`- Windows: run \`${assets.irisWindowsX64}\`.`)
    }
    lines.push('')
  }

  lines.push('## Downloads', '')
  for (const entry of [...assetEntries].sort((left, right) => left.name.localeCompare(right.name))) {
    lines.push(`- \`${entry.name}\``)
  }

  lines.push('', '## Build Info', '', `- Release \`${tag}\` from commit \`${commit}\`.`)
  if (assets.irisMacArm64 || assets.irisLinuxAppImage || assets.irisLinuxDeb || assets.irisWindowsX64) {
    lines.push('- Includes Iris desktop release assets.')
  } else {
    lines.push('- No Iris desktop release assets were staged.')
  }

  return `${lines.join('\n')}\n`
}

export function stageRepoRelease({
  tag,
  commit,
  cliDir,
  outputDir,
  irisStageDir = '',
  installUrl = '',
  title = '',
}) {
  if (!tag) {
    throw new Error('Missing --tag')
  }
  if (!commit) {
    throw new Error('Missing --commit')
  }
  if (!outputDir) {
    throw new Error('Missing --output-dir')
  }

  const assetEntries = [...buildCliAssetEntries(cliDir), ...buildIrisAssetEntries(irisStageDir)]
  if (assetEntries.length === 0) {
    throw new Error('No release assets found to stage')
  }

  const seenPaths = new Set()
  for (const entry of assetEntries) {
    if (seenPaths.has(entry.relativePath)) {
      throw new Error(`Duplicate staged asset path: ${entry.relativePath}`)
    }
    seenPaths.add(entry.relativePath)
  }

  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(join(outputDir, 'assets'), { recursive: true })

  const manifestAssets = []
  for (const entry of assetEntries) {
    const destination = join(outputDir, entry.relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(entry.sourcePath, destination)
    manifestAssets.push({
      name: entry.name,
      path: entry.relativePath,
      size: statSync(destination).size,
    })
  }

  const createdAt = Math.floor(Date.now() / 1000)
  const record = {
    id: tag,
    title: title || tag,
    tag,
    commit,
    created_at: createdAt,
    published_at: createdAt,
    draft: false,
    prerelease: tag.includes('-'),
    notes_file: 'notes.md',
    assets: manifestAssets.sort((left, right) => left.name.localeCompare(right.name)),
  }

  writeFileSync(join(outputDir, 'notes.md'), renderReleaseNotes({ tag, commit, assetEntries: manifestAssets, installUrl }))
  writeFileSync(join(outputDir, 'release.json'), `${JSON.stringify(record, null, 2)}\n`)

  return {
    outputDir,
    assetCount: manifestAssets.length,
  }
}

function isMainModule() {
  if (!process.argv[1]) {
    return false
  }

  return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log(usage())
      process.exit(0)
    }
    const result = stageRepoRelease(options)
    console.log(`Staged ${result.assetCount} release asset(s) in ${result.outputDir}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
