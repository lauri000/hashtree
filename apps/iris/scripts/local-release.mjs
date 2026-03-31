#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  assetPrefixForTag,
  autoDetectWindowsVmName,
  buildReleaseManifest,
  normalizeTag,
  parseEnvFile,
  readWorkspaceVersionTag,
  renderReleaseNotes,
  splitCsv,
} from './local-release-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const repoRoot = resolve(appDir, '..', '..')
const rootCargoToml = join(repoRoot, 'rust', 'Cargo.toml')
const distDir = join(repoRoot, 'dist', 'iris-native')
const frontendDistDir = join(appDir, 'dist')
const packagingConfig = 'src-tauri/tauri.release.no-frontend.json'
const dockerfile = join(appDir, 'scripts', 'Dockerfile.native-linux-release')
const defaultEnvFiles = [
  join(repoRoot, '.env.release.local'),
  join(appDir, '.env.release.local'),
]
const frontendInstallDirs = ['apps/iris-files', 'apps/iris']

class SkipStepError extends Error {}

export function usage() {
  return `Usage: node apps/iris/scripts/local-release.mjs [options]

Build locally-available Iris desktop release artifacts, stage a hashtree release directory,
and optionally publish it.

Options:
  --publish                 Publish the staged release tree with htree
  --dry-run                 Print the plan without running build or publish commands
  --skip-verify            Skip frontend verification
  --tag <tag>              Release tag (defaults to rust workspace version, for example v0.2.14)
  --release-tree <name>    Mutable release tree name to publish into
  --stage-dir <path>       Directory used for staged release metadata
  --env-file <path>        Extra dotenv file to load (repeatable)
  --only <csv>             Limit steps to verify,macos,linux,windows
  --skip <csv>             Skip steps by name
  --help                   Show this help

Notes:
  - macOS app bundles build locally on Apple Silicon macOS.
  - Linux bundles build natively on Linux or inside Docker elsewhere.
  - Windows installers build inside a Parallels Windows VM when available.
  - --publish requires an explicit --release-tree so partial app-only releases do not
    accidentally overwrite the repo's combined release tree.`
}

export function parseArgs(argv) {
  const args = [...argv].filter((arg, index) => !(arg === '--' && index === 0))
  const options = {
    dryRun: false,
    publish: false,
    skipVerify: false,
    releaseTree: null,
    stageDir: null,
    tag: null,
    envFiles: [],
    only: null,
    skip: new Set(),
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    switch (arg) {
      case '--help':
      case '-h':
        return { help: true }
      case '--publish':
        options.publish = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--skip-verify':
        options.skipVerify = true
        break
      case '--tag':
        options.tag = normalizeTag(args[++index] ?? '')
        break
      case '--release-tree':
        options.releaseTree = args[++index] ?? ''
        break
      case '--stage-dir':
        options.stageDir = args[++index] ?? ''
        break
      case '--env-file':
        options.envFiles.push(resolve(repoRoot, args[++index] ?? ''))
        break
      case '--only':
        options.only = new Set(splitCsv(args[++index] ?? ''))
        break
      case '--skip':
        for (const value of splitCsv(args[++index] ?? '')) {
          options.skip.add(value)
        }
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

export function windowsArtifactArch(targetTriple) {
  if (targetTriple.startsWith('x86_64-')) {
    return 'x64'
  }
  if (targetTriple.startsWith('aarch64-')) {
    return 'arm64'
  }

  return targetTriple
}

export function workspaceInstallCommands(pnpmCommand = 'pnpm', installDirs = frontendInstallDirs) {
  return installDirs.map((dir) => `${pnpmCommand} --dir ${dir} install --frozen-lockfile --ignore-scripts`)
}

export function linuxDockerShellCommand(target = 'x86_64-unknown-linux-gnu') {
  return [
    'set -euo pipefail',
    'export CI=true',
    'pnpm config set store-dir /pnpm/store',
    ...workspaceInstallCommands('pnpm'),
    `pnpm --dir apps/iris exec tauri build --config ${quote(packagingConfigPath())} --target ${target} --bundles appimage,deb --ci`,
  ].join(' && ')
}

export function linuxDockerVolumeMounts(currentRepoRoot = repoRoot) {
  return [
    `${currentRepoRoot}:/workspace`,
    'hashtree-iris-release-iris-files-node-modules:/workspace/apps/iris-files/node_modules',
    'hashtree-iris-release-node-modules:/workspace/apps/iris/node_modules',
    'hashtree-iris-release-pnpm-store:/pnpm/store',
    'hashtree-iris-release-target:/workspace/apps/iris/src-tauri/target',
    'hashtree-iris-release-cargo-registry:/root/.cargo/registry',
    'hashtree-iris-release-cargo-git:/root/.cargo/git',
  ]
}

export function packagingConfigPath() {
  return packagingConfig
}

export function defaultSharedWindowsRepoPath(currentRepoRoot = repoRoot) {
  if (process.platform !== 'darwin') {
    return null
  }

  const homeDir = os.homedir()
  if (!currentRepoRoot.startsWith(`${homeDir}/`)) {
    return null
  }

  const relative = currentRepoRoot.slice(homeDir.length + 1).split('/').join('\\')
  return `C:\\Mac\\Home\\${relative}`
}

function readOptionalEnvFiles(envFiles) {
  const loaded = {}
  const loadedPaths = []

  for (const envFile of envFiles) {
    if (!existsSync(envFile)) {
      continue
    }

    Object.assign(loaded, parseEnvFile(readFileSync(envFile, 'utf8')))
    loadedPaths.push(envFile)
  }

  return { loaded, loadedPaths }
}

function commandExists(command) {
  const result =
    process.platform === 'win32'
      ? spawnSync('where', [command], { stdio: 'ignore' })
      : spawnSync('sh', ['-lc', `command -v "${command}"`], { stdio: 'ignore' })

  return result.status === 0
}

function quote(arg) {
  const value = String(arg)
  return /[^\w./:-]/.test(value) ? JSON.stringify(value) : value
}

function run(command, args, { cwd = repoRoot, env = process.env, capture = false, dryRun = false } = {}) {
  const rendered = [command, ...args].map(quote).join(' ')
  console.log(`$ ${rendered}`)
  if (dryRun) {
    return ''
  }

  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })

  if (result.status !== 0) {
    const stderr = capture ? result.stderr.trim() : ''
    throw new Error(stderr || `${command} exited with status ${result.status ?? 'unknown'}`)
  }

  return capture ? result.stdout.trim() : ''
}

function resolveHostPnpmInvocation() {
  if (commandExists('pnpm')) {
    return ['pnpm']
  }
  if (commandExists('corepack')) {
    return ['corepack', 'pnpm']
  }

  throw new Error('Missing pnpm (or corepack) on the local host')
}

function runPnpm(pnpmInvocation, args, options = {}) {
  const [command, ...prefix] = pnpmInvocation
  return run(command, [...prefix, ...args], options)
}

function installFrontendDependencies(pnpmInvocation, { dryRun }) {
  for (const dir of frontendInstallDirs) {
    runPnpm(pnpmInvocation, ['--dir', join(repoRoot, dir), 'install', '--frozen-lockfile', '--ignore-scripts'], { dryRun })
  }
}

function ensureFrontendDistAvailable(dryRun) {
  if (dryRun) {
    return
  }
  if (!existsSync(join(frontendDistDir, 'index.html'))) {
    throw new Error('Missing apps/iris/dist. Run verify first or build the frontend before packaging.')
  }
}

function ensureDistDir(dryRun) {
  if (!dryRun) {
    mkdirSync(distDir, { recursive: true })
  }
}

function findFirstFile(root, matcher) {
  if (!existsSync(root)) {
    return null
  }

  const entries = readdirSync(root).sort()
  const match = entries.find((entry) => matcher(entry))
  return match ? join(root, match) : null
}

function findBundleArtifact(candidates, subdir, matcher) {
  for (const candidate of candidates) {
    const file = findFirstFile(join(candidate, subdir), matcher)
    if (file) {
      return file
    }
  }

  return null
}

function appBundleCandidates(target) {
  return [
    join(appDir, 'src-tauri', 'target', target, 'release', 'bundle'),
    join(appDir, 'src-tauri', 'target', 'release', 'bundle'),
    join(repoRoot, 'target', target, 'release', 'bundle'),
    join(repoRoot, 'target', 'release', 'bundle'),
  ]
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function runWindowsPowerShell(vmName, script, { capture = false, dryRun = false } = {}) {
  return run(
    'prlctl',
    ['exec', vmName, '--current-user', 'powershell.exe', '-NoProfile', '-Command', script],
    { capture, dryRun },
  )
}

function shouldRunStep(step, options) {
  if (options.skipVerify && step === 'verify') {
    return false
  }
  if (options.only && !options.only.has(step)) {
    return false
  }
  if (options.skip.has(step)) {
    return false
  }
  return true
}

function syncRepoToWindowsVm({ vmName, sharedRepoPath, dryRun }) {
  const script = `
$sharedRepo = ${psQuote(sharedRepoPath)}
$guestRepo = Join-Path $env:USERPROFILE 'src\\hashtree'
$guestRoot = Split-Path $guestRepo
New-Item -ItemType Directory -Force -Path $guestRoot | Out-Null
robocopy $sharedRepo $guestRepo /MIR /XD target node_modules .pnpm-store .git | Out-Null
$binDir = Join-Path $env:USERPROFILE 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shimPath = Join-Path $binDir 'pnpm.cmd'
$shimLines = @(
  '@echo off'
  'corepack pnpm %*'
)
Set-Content -Encoding ASCII -Path $shimPath -Value $shimLines
`

  runWindowsPowerShell(vmName, script, { dryRun })
}

function buildWindowsArtifacts({ env, assetPrefix, dryRun, builtLines }) {
  if (process.platform !== 'darwin') {
    throw new SkipStepError('Windows installer builds are only wired up for the macOS + Parallels workflow.')
  }
  if (!commandExists('prlctl')) {
    throw new SkipStepError('Skipping Windows installers because prlctl is unavailable.')
  }

  const sharedRepoPath = env.IRIS_WINDOWS_SHARED_REPO_PATH || defaultSharedWindowsRepoPath()
  if (!sharedRepoPath) {
    throw new SkipStepError('Skipping Windows installers because the shared repo path could not be derived; set IRIS_WINDOWS_SHARED_REPO_PATH.')
  }

  const vmName =
    env.IRIS_WINDOWS_VM_NAME ||
    autoDetectWindowsVmName(run('prlctl', ['list', '-a'], { capture: true, dryRun }))
  if (!vmName) {
    throw new SkipStepError('Skipping Windows installers because no unique running Windows VM was detected; set IRIS_WINDOWS_VM_NAME.')
  }

  ensureFrontendDistAvailable(dryRun)
  ensureDistDir(dryRun)
  syncRepoToWindowsVm({ vmName, sharedRepoPath, dryRun })

  const guiTargets = splitCsv(env.IRIS_WINDOWS_GUI_TARGETS || 'x86_64-pc-windows-msvc')
  const guestRepo = "(Join-Path $env:USERPROFILE 'src\\hashtree')"
  const distPath = `${sharedRepoPath}\\dist\\iris-native`
  const pathSetup = "$env:PATH = (Join-Path $env:USERPROFILE 'bin') + ';' + $env:PATH"

  runWindowsPowerShell(
    vmName,
    `
${pathSetup}
Set-Location ${guestRepo}
${workspaceInstallCommands('corepack pnpm').join('\n')}
New-Item -ItemType Directory -Force -Path ${psQuote(distPath)} | Out-Null
`,
    { dryRun },
  )

  for (const target of guiTargets) {
    const arch = windowsArtifactArch(target)
    const installerName = `${assetPrefix}-windows-${arch}-setup.exe`
    runWindowsPowerShell(
      vmName,
      `
${pathSetup}
Set-Location ${guestRepo}
corepack pnpm --dir apps/iris exec tauri build --config ${psQuote(packagingConfigPath())} --target ${psQuote(target)} --bundles nsis --ci
$bundleDir = Join-Path ${guestRepo} ${psQuote(`apps\\iris\\src-tauri\\target\\${target}\\release\\bundle\\nsis`)}
$installer = Get-ChildItem $bundleDir -Filter '*-setup.exe' | Select-Object -First 1
if (-not $installer) { throw ${psQuote(`No NSIS installer found for ${target}`)} }
Copy-Item $installer.FullName ${psQuote(`${distPath}\\${installerName}`)} -Force
`,
      { dryRun },
    )
    builtLines.push(`Built Windows ${arch} Iris NSIS installer inside Parallels VM ${vmName}.`)
  }
}

function buildMacosArtifacts({ pnpmInvocation, assetPrefix, dryRun, builtLines }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new SkipStepError('Skipping macOS app bundle because the host is not Apple Silicon macOS.')
  }

  ensureFrontendDistAvailable(dryRun)
  ensureDistDir(dryRun)
  installFrontendDependencies(pnpmInvocation, { dryRun })
  runPnpm(
    pnpmInvocation,
    ['--dir', appDir, 'exec', 'tauri', 'build', '--config', packagingConfigPath(), '--target', 'aarch64-apple-darwin', '--bundles', 'app', '--no-sign', '--ci'],
    { dryRun },
  )

  const appPath = findBundleArtifact(
    appBundleCandidates('aarch64-apple-darwin'),
    'macos',
    (entry) => entry.endsWith('.app'),
  )
  if (!dryRun && !appPath) {
    throw new Error('No macOS .app bundle found in build output.')
  }

  run(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath || '<macos-app-bundle>', join(distDir, `${assetPrefix}-macos-arm64.zip`)],
    { dryRun },
  )

  builtLines.push('Built Apple Silicon macOS Iris app locally.')
}

function buildLinuxArtifacts({ pnpmInvocation, env, assetPrefix, dryRun, builtLines }) {
  const target = 'x86_64-unknown-linux-gnu'
  const appImageDest = join(distDir, `${assetPrefix}-linux-x86_64.AppImage`)
  const debDest = join(distDir, `${assetPrefix}-linux-x86_64.deb`)

  ensureFrontendDistAvailable(dryRun)
  ensureDistDir(dryRun)

  if (process.platform === 'linux') {
    installFrontendDependencies(pnpmInvocation, { dryRun })
    runPnpm(
      pnpmInvocation,
      ['--dir', appDir, 'exec', 'tauri', 'build', '--config', packagingConfigPath(), '--target', target, '--bundles', 'appimage,deb', '--ci'],
      { dryRun },
    )
  } else {
    if (!commandExists('docker')) {
      throw new SkipStepError('Skipping Linux bundles because docker is unavailable.')
    }

    const imageName = env.IRIS_RELEASE_DOCKER_IMAGE || 'hashtree/iris-native-linux-release'
    const platform = env.IRIS_RELEASE_DOCKER_PLATFORM || 'linux/amd64'
    const command = linuxDockerShellCommand(target)

    run('docker', ['build', '--platform', platform, '-f', dockerfile, '-t', imageName, dirname(dockerfile)], { dryRun })
    run(
      'docker',
      [
        'run',
        '--rm',
        '--platform',
        platform,
        '-e',
        'CI=true',
        ...linuxDockerVolumeMounts(repoRoot).flatMap((mount) => ['-v', mount]),
        '-w',
        '/workspace',
        imageName,
        'bash',
        '-lc',
        command,
      ],
      { dryRun },
    )
  }

  const appImagePath = findBundleArtifact(
    appBundleCandidates(target),
    'appimage',
    (entry) => entry.endsWith('.AppImage'),
  )
  const debPath = findBundleArtifact(
    appBundleCandidates(target),
    'deb',
    (entry) => entry.endsWith('.deb'),
  )

  if (!dryRun && !appImagePath) {
    throw new Error('No Linux AppImage bundle found in build output.')
  }
  if (!dryRun && !debPath) {
    throw new Error('No Linux .deb bundle found in build output.')
  }

  if (!dryRun) {
    copyFileSync(appImagePath, appImageDest)
    copyFileSync(debPath, debDest)
  }

  builtLines.push(process.platform === 'linux'
    ? 'Built Linux Iris AppImage and .deb locally.'
    : 'Built Linux Iris AppImage and .deb through Docker.')
}

function runVerify({ pnpmInvocation, dryRun, builtLines }) {
  installFrontendDependencies(pnpmInvocation, { dryRun })
  runPnpm(pnpmInvocation, ['--dir', appDir, 'build'], { dryRun })
  runPnpm(pnpmInvocation, ['--dir', appDir, 'run', 'test:icons'], { dryRun })
  builtLines.push('Ran pnpm build and test:icons for Iris.')
}

export function collectReleaseAssetPaths(assetPrefix, outputDir = distDir) {
  if (!existsSync(outputDir)) {
    return []
  }

  return readdirSync(outputDir)
    .sort()
    .map((entry) => join(outputDir, entry))
    .filter((fullPath) => statSync(fullPath).isFile())
    .filter((fullPath) => basename(fullPath).startsWith(`${assetPrefix}-`))
}

function stageRelease({ tag, commit, stageDir, outputDir, assetPrefix, builtLines, skippedLines, dryRun }) {
  const assetPaths = collectReleaseAssetPaths(assetPrefix, outputDir)
  if (dryRun) {
    console.log(`Would stage ${assetPaths.length} currently visible asset(s) into ${stageDir}`)
    return { assetPaths, stageDir }
  }

  if (assetPaths.length === 0) {
    throw new Error(`No Iris release assets found for ${tag} in ${outputDir}.`)
  }

  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(join(stageDir, 'assets'), { recursive: true })

  const stagedAssetPaths = []
  for (const assetPath of assetPaths) {
    const stagedPath = join(stageDir, 'assets', basename(assetPath))
    copyFileSync(assetPath, stagedPath)
    stagedAssetPaths.push(stagedPath)
  }

  const createdAt = Math.floor(Date.now() / 1000)
  const manifest = buildReleaseManifest({
    tag,
    commit,
    createdAt,
    assetPaths: stagedAssetPaths,
  })

  writeFileSync(join(stageDir, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(
    join(stageDir, 'notes.md'),
    renderReleaseNotes({
      tag,
      commit,
      assetNames: stagedAssetPaths.map((assetPath) => basename(assetPath)),
      builtLines,
      skippedLines,
    }),
  )

  return { assetPaths, stageDir }
}

function publishRelease({ stageDir, releaseTree, tag, dryRun }) {
  if (!releaseTree) {
    throw new Error('--publish requires an explicit --release-tree')
  }

  if (dryRun) {
    console.log(`Would publish ${tag} from ${stageDir} into ${releaseTree}`)
    return 'dry-run'
  }

  const addOutput = run('htree', ['add', stageDir], { capture: true, dryRun })
  const match = addOutput.match(/^\s*url:\s*(\S+)/m)
  if (!match) {
    throw new Error('Could not parse htree add output for release CID.')
  }

  const cid = match[1]
  run('htree', ['release', 'publish', releaseTree, tag, cid], { dryRun })
  return cid
}

function isMainModule() {
  if (!process.argv[1]) {
    return false
  }
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const { loaded, loadedPaths } = readOptionalEnvFiles([...defaultEnvFiles, ...options.envFiles])
  const env = { ...loaded, ...process.env }
  const tag = options.tag || readWorkspaceVersionTag(readFileSync(rootCargoToml, 'utf8'))
  const assetPrefix = assetPrefixForTag(tag)
  const stageDir =
    options.stageDir || join(os.tmpdir(), `iris-release-${tag.replace(/[^\w.-]/g, '_')}`)

  const builtLines = []
  const skippedLines = []
  const failures = []

  console.log(`Release tag: ${tag}`)
  console.log(`Asset prefix: ${assetPrefix}`)
  console.log(`Output dir: ${distDir}`)
  if (options.releaseTree) {
    console.log(`Release tree: ${options.releaseTree}`)
  }
  if (loadedPaths.length > 0) {
    console.log(`Loaded env files: ${loadedPaths.join(', ')}`)
  }
  if (options.dryRun) {
    console.log('Dry run mode: no build, copy, or publish commands will be executed.')
  }

  const pnpmInvocation = resolveHostPnpmInvocation()
  const steps = [
    ['verify', () => runVerify({ pnpmInvocation, dryRun: options.dryRun, builtLines })],
    ['macos', () => buildMacosArtifacts({ pnpmInvocation, assetPrefix, dryRun: options.dryRun, builtLines })],
    ['linux', () => buildLinuxArtifacts({ pnpmInvocation, env, assetPrefix, dryRun: options.dryRun, builtLines })],
    ['windows', () => buildWindowsArtifacts({ env, assetPrefix, dryRun: options.dryRun, builtLines })],
  ]

  for (const [name, fn] of steps) {
    if (!shouldRunStep(name, options)) {
      skippedLines.push(`${name} skipped by CLI options.`)
      continue
    }

    try {
      fn()
    } catch (error) {
      if (error instanceof SkipStepError) {
        skippedLines.push(error.message)
        continue
      }
      if (name === 'verify') {
        throw error
      }
      const message = `${name} build failed: ${error.message}`
      skippedLines.push(message)
      failures.push(message)
    }
  }

  const commit = run('git', ['rev-parse', 'HEAD'], { capture: true, dryRun: options.dryRun }) || 'HEAD'
  stageRelease({
    tag,
    commit,
    stageDir,
    outputDir: distDir,
    assetPrefix,
    builtLines,
    skippedLines,
    dryRun: options.dryRun,
  })

  if (failures.length > 0) {
    throw new Error(failures.join('; '))
  }

  if (options.publish) {
    if (!commandExists('htree')) {
      throw new Error('Missing htree; cannot publish release.')
    }
    const cid = publishRelease({
      stageDir,
      releaseTree: options.releaseTree,
      tag,
      dryRun: options.dryRun,
    })
    console.log(`Published ${tag} to ${options.releaseTree} via ${cid}`)
  } else {
    console.log(`Staged release at ${stageDir}`)
  }
}

if (isMainModule()) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
