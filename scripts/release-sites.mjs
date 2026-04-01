import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function resolveRepoRoot(envKey, defaultName) {
  const direct = process.env[envKey];
  if (direct) {
    return path.resolve(direct);
  }
  return path.resolve(repoRoot, '..', defaultName);
}

export function parseArgs(argv) {
  const args = [...argv].filter((arg, index) => !(arg === '--' && index === 0));
  let dryRun = false;
  let skipCloudflare = false;
  let workerCompatibilityDate;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--skip-cloudflare' || arg === '--skip-pages') {
      skipCloudflare = true;
      continue;
    }
    if (arg === '--compatibility-date') {
      workerCompatibilityDate = args.shift();
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    dryRun,
    skipCloudflare,
    workerCompatibilityDate,
  };
}

function appendSharedFlags(targetArgs, options) {
  if (options.skipCloudflare) {
    targetArgs.push('--skip-cloudflare');
  }
  if (options.dryRun) {
    targetArgs.push('--dry-run');
  }
  if (options.workerCompatibilityDate) {
    targetArgs.push('--compatibility-date', options.workerCompatibilityDate);
  }
  return targetArgs;
}

export function createReleaseCommands(options) {
  const irisAppsRepoRoot = resolveRepoRoot('IRIS_APPS_REPO_ROOT', 'iris-apps');
  const hashtreeCcRepoRoot = resolveRepoRoot('HASHTREE_CC_REPO_ROOT', 'hashtree-cc');
  return [
    {
      label: 'Release iris-files sites',
      command: process.execPath,
      args: appendSharedFlags(['apps/iris-files/scripts/release-site.mjs', 'all'], options),
      cwd: irisAppsRepoRoot,
    },
    {
      label: 'Release hashtree.cc',
      command: process.execPath,
      args: appendSharedFlags(['apps/hashtree-cc/scripts/release-site.mjs'], options),
      cwd: hashtreeCcRepoRoot,
    },
  ];
}

function defaultRunner(step) {
  console.log(`\n==> ${step.label}`);
  console.log(`$ ${[step.command, ...step.args].join(' ')}`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result.status ?? 1;
}

export function usage() {
  return `Usage: node ./scripts/release-sites.mjs [options]

Run the sibling static-site releases sequentially:
  1. ../iris-apps (apps/iris-files all profiles)
  2. ../hashtree-cc

Options:
  --compatibility-date  Worker compatibility date override passed to each site release
  --skip-cloudflare     publish to hashtree only
  --skip-pages          alias for --skip-cloudflare
  --dry-run             print planned commands without running them

Environment:
  IRIS_APPS_REPO_ROOT   override the iris-apps checkout path
  HASHTREE_CC_REPO_ROOT override the hashtree-cc checkout path
`;
}

export function runReleases(options, runner = defaultRunner) {
  const commands = createReleaseCommands(options);

  if (options.dryRun) {
    return {
      dryRun: true,
      commands,
    };
  }

  for (const command of commands) {
    const status = runner(command);
    if (status !== 0) {
      throw new Error(`${command.label} failed with exit code ${status}`);
    }
  }

  return { commands };
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  return path.resolve(process.argv[1]) === __filename;
}

if (isMainModule()) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(usage());
      process.exit(0);
    }

    const result = runReleases(parsed);
    if (result.dryRun) {
      console.log(usage());
      for (const command of result.commands) {
        console.log(`${command.label}: ${[command.command, ...command.args].join(' ')} (cwd: ${command.cwd})`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
