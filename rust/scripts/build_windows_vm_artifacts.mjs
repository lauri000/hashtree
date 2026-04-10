#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = dirname(scriptPath)
const rustDir = dirname(scriptDir)
const repoDir = dirname(rustDir)

function usage() {
  return `Usage: node rust/scripts/build_windows_vm_artifacts.mjs --output-dir <dir> [options]

Build Windows CLI binaries inside a Parallels Windows VM and copy the resulting
.exe files into a host output directory that is reachable through the Parallels
shared home folder.

Options:
  --output-dir <dir>             Host output directory for built .exe files
  --vm-name <name>               Override the Parallels VM name
  --shared-repo-path <path>      Override the repo path inside Parallels shared folders
  --guest-repo-path <path>       Override the guest repo path used for the build
  -h, --help                     Show this help
`
}

export function parseArgs(argv) {
  const args = [...argv]
  const options = {
    outputDir: '',
    vmName: '',
    sharedRepoPath: '',
    guestRepoPath: '',
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    switch (arg) {
      case '--output-dir':
        options.outputDir = resolve(args[++index] ?? '')
        break
      case '--vm-name':
        options.vmName = args[++index] ?? ''
        break
      case '--shared-repo-path':
        options.sharedRepoPath = args[++index] ?? ''
        break
      case '--guest-repo-path':
        options.guestRepoPath = args[++index] ?? ''
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

export function defaultSharedWindowsPath(hostPath, homeDir = os.homedir()) {
  const resolvedPath = resolve(hostPath)
  const resolvedHome = resolve(homeDir)

  if (resolvedPath === resolvedHome) {
    return 'C:\\Mac\\Home'
  }
  if (!resolvedPath.startsWith(`${resolvedHome}/`)) {
    return null
  }

  const relativePath = resolvedPath.slice(resolvedHome.length + 1).split('/').join('\\')
  return `C:\\Mac\\Home\\${relativePath}`
}

export function autoDetectWindowsVmName(prlctlListOutput) {
  const candidates = []
  for (const rawLine of prlctlListOutput.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('{')) {
      continue
    }

    const match = line.match(/^\{[^}]+\}\s+(\S+)\s+\S+\s+(.+)$/)
    if (!match) {
      continue
    }

    const status = match[1].toLowerCase()
    const name = match[2].trim()
    if ((status === 'running' || status === 'suspended') && /windows/i.test(name)) {
      candidates.push(name)
    }
  }

  return candidates.length === 1 ? candidates[0] : null
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    if (capture) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('').trim()
      throw new Error(output || `${command} exited with status ${result.status}`)
    }
    throw new Error(`${command} exited with status ${result.status}`)
  }

  return capture ? result.stdout.trim() : ''
}

function batchQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

export function windowsBuildScriptLines({
  sharedRepoPath,
  guestRepoPath,
  sharedOutputDir,
}) {
  const guestRepoValue = guestRepoPath || '%USERPROFILE%\\src\\hashtree'
  return [
    '@echo off',
    'setlocal',
    `set "SHARED_REPO=${sharedRepoPath}"`,
    `set "GUEST_REPO=${guestRepoValue}"`,
    `set "SHARED_OUTPUT=${sharedOutputDir}"`,
    'for %%I in ("%GUEST_REPO%") do set "GUEST_ROOT=%%~dpI"',
    'if not exist "%GUEST_ROOT%" mkdir "%GUEST_ROOT%"',
    'if exist "%GUEST_REPO%" rmdir /S /Q "%GUEST_REPO%"',
    'if exist "%GUEST_REPO%" exit /b 20',
    'mkdir "%GUEST_REPO%"',
    'if errorlevel 1 exit /b %errorlevel%',
    'if not exist "%SHARED_OUTPUT%" mkdir "%SHARED_OUTPUT%"',
    'robocopy "%SHARED_REPO%" "%GUEST_REPO%" /E /XD "%SHARED_REPO%\\.git" "%SHARED_REPO%\\dist" "%SHARED_REPO%\\node_modules" "%SHARED_REPO%\\.pnpm-store" "%SHARED_REPO%\\artifacts" "%SHARED_REPO%\\rust\\target" "%SHARED_REPO%\\apps\\iris\\src-tauri\\target" /XF .env.release.local .env.zapstore.local',
    'if errorlevel 8 exit /b %errorlevel%',
    'set "VSWHERE=C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe"',
    'if not exist "%VSWHERE%" exit /b 10',
    'set "VS_INSTALL_PATH="',
    'for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath -utf8`) do set "VS_INSTALL_PATH=%%I"',
    'if not defined VS_INSTALL_PATH exit /b 11',
    'set "VS_DEV_CMD=%VS_INSTALL_PATH%\\Common7\\Tools\\VsDevCmd.bat"',
    'if not exist "%VS_DEV_CMD%" exit /b 12',
    'if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (set "HOST_ARCH=arm64") else if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" (set "HOST_ARCH=amd64") else (set "HOST_ARCH=x86")',
    'call "%VS_DEV_CMD%" -arch=amd64 -host_arch=%HOST_ARCH%',
    'if errorlevel 1 exit /b %errorlevel%',
    'cd /d "%GUEST_REPO%\\rust"',
    'if errorlevel 1 exit /b %errorlevel%',
    'set CARGO_NET_GIT_FETCH_WITH_CLI=false',
    'cargo build --release --locked --target x86_64-pc-windows-msvc -p hashtree-cli --bin htree',
    'if errorlevel 1 exit /b %errorlevel%',
    'cargo build --release --locked --target x86_64-pc-windows-msvc -p hashtree-cashu-cli --bin htree-cashu',
    'if errorlevel 1 exit /b %errorlevel%',
    'cargo build --release --locked --target x86_64-pc-windows-msvc -p git-remote-htree --bin git-remote-htree',
    'if errorlevel 1 exit /b %errorlevel%',
    'copy /Y "%GUEST_REPO%\\rust\\target\\x86_64-pc-windows-msvc\\release\\htree.exe" "%SHARED_OUTPUT%\\htree.exe"',
    'if errorlevel 1 exit /b %errorlevel%',
    'copy /Y "%GUEST_REPO%\\rust\\target\\x86_64-pc-windows-msvc\\release\\htree-cashu.exe" "%SHARED_OUTPUT%\\htree-cashu.exe"',
    'if errorlevel 1 exit /b %errorlevel%',
    'copy /Y "%GUEST_REPO%\\rust\\target\\x86_64-pc-windows-msvc\\release\\git-remote-htree.exe" "%SHARED_OUTPUT%\\git-remote-htree.exe"',
    'if errorlevel 1 exit /b %errorlevel%',
  ]
}

function writeWindowsBuildScript({
  scriptPath,
  sharedRepoPath,
  guestRepoPath,
  sharedOutputDir,
}) {
  const lines = windowsBuildScriptLines({
    sharedRepoPath,
    guestRepoPath,
    sharedOutputDir,
  })
  writeFileSync(scriptPath, `${lines.join('\r\n')}\r\n`, 'utf8')
}

export function buildWindowsVmArtifacts({
  outputDir,
  vmName = '',
  sharedRepoPath = '',
  guestRepoPath = '',
}) {
  if (!outputDir) {
    throw new Error('Missing --output-dir')
  }
  if (process.platform !== 'darwin') {
    throw new Error('Windows VM builds are only supported from macOS hosts.')
  }

  const resolvedOutputDir = resolve(outputDir)
  const effectiveSharedRepoPath = sharedRepoPath || defaultSharedWindowsPath(repoDir)
  if (!effectiveSharedRepoPath) {
    throw new Error(
      'Could not derive the Parallels shared repo path from the current workspace. Pass --shared-repo-path.',
    )
  }

  const sharedOutputDir = defaultSharedWindowsPath(resolvedOutputDir)
  if (!sharedOutputDir) {
    throw new Error(
      'Output dir must live under your home directory so Parallels shared folders can reach it.',
    )
  }

  const effectiveVmName =
    vmName || autoDetectWindowsVmName(run('prlctl', ['list', '-a'], { capture: true }))
  if (!effectiveVmName) {
    throw new Error(
      'Could not find a unique running Windows VM. Pass --vm-name to choose one explicitly.',
    )
  }

  rmSync(resolvedOutputDir, { recursive: true, force: true })
  mkdirSync(resolvedOutputDir, { recursive: true })
  const localScriptPath = join(rustDir, 'dist', `windows-vm-build-${Date.now()}.cmd`)
  const sharedScriptPath = defaultSharedWindowsPath(localScriptPath)
  if (!sharedScriptPath) {
    throw new Error('Could not derive a Parallels shared path for the temporary Windows build script.')
  }

  writeWindowsBuildScript({
    scriptPath: localScriptPath,
    sharedRepoPath: effectiveSharedRepoPath,
    guestRepoPath,
    sharedOutputDir,
  })

  try {
    run('prlctl', [
      'exec',
      effectiveVmName,
      '--current-user',
      'cmd.exe',
      '/c',
      batchQuote(sharedScriptPath),
    ])
  } finally {
    rmSync(localScriptPath, { force: true })
  }

  return {
    outputDir: resolvedOutputDir,
    sharedOutputDir,
    vmName: effectiveVmName,
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  if (!options.outputDir) {
    throw new Error('Missing --output-dir')
  }

  const result = buildWindowsVmArtifacts(options)
  console.log(`Built Windows CLI artifacts in ${result.outputDir} via ${result.vmName}.`)
}

if (process.argv[1] === scriptPath) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
