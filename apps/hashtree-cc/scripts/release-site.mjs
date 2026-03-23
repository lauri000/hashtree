import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const manifestPath = path.join(repoRoot, 'rust', 'Cargo.toml');
const defaultWorkerCompatibilityDate = '2026-03-19';

export const releaseProfile = {
  appName: 'hashtree.cc',
  distDir: 'dist',
  treeName: 'hashtree-cc',
  defaultWorkerName: 'hashtree-cc',
  workerNameEnv: 'CF_WORKER_NAME_HASHTREE_CC',
  pagesProjectEnv: 'CF_PAGES_PROJECT_HASHTREE_CC',
  buildCommand: ['pnpm', 'run', 'build'],
  testCommands: [
    ['node', '--test', 'tests/portable-build.test.mjs'],
    ['node', './scripts/portable-smoke.mjs'],
  ],
};

function wranglerPagesCommand(...args) {
  return ['npx', 'wrangler@4', ...args];
}

function wranglerWorkerAssetsCommand(...args) {
  return ['npx', 'wrangler@4', 'deploy', ...args];
}

export function parseArgs(argv, env = process.env) {
  const args = [...argv].filter((arg, index) => !(arg === '--' && index === 0));
  let pagesProject;
  let workerName;
  let treeName;
  let branch;
  let dryRun = false;
  let skipCloudflare = false;
  let pagesOnly = false;
  const routes = [];
  const domains = [];
  let workerCompatibilityDate;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg === '--') {
      continue;
    }
    if (arg === '--pages-project') {
      pagesProject = args.shift();
      continue;
    }
    if (arg === '--worker-name') {
      workerName = args.shift();
      continue;
    }
    if (arg === '--tree') {
      treeName = args.shift();
      continue;
    }
    if (arg === '--route') {
      routes.push(args.shift());
      continue;
    }
    if (arg === '--domain') {
      domains.push(args.shift());
      continue;
    }
    if (arg === '--branch') {
      branch = args.shift();
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--compatibility-date') {
      workerCompatibilityDate = args.shift();
      continue;
    }
    if (arg === '--skip-cloudflare' || arg === '--skip-pages') {
      skipCloudflare = true;
      continue;
    }
    if (arg === '--pages-only') {
      pagesOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (pagesOnly && workerName) {
    throw new Error('--pages-only is not compatible with --worker-name');
  }
  if (pagesOnly && (routes.length > 0 || domains.length > 0)) {
    throw new Error('--pages-only is not compatible with --route/--domain');
  }

  return {
    dryRun,
    skipCloudflare,
    pagesOnly,
    branch,
    treeName: treeName ?? releaseProfile.treeName,
    workerName: pagesOnly
      ? undefined
      : workerName ?? env[releaseProfile.workerNameEnv] ?? releaseProfile.defaultWorkerName,
    pagesProject: pagesProject ?? env[releaseProfile.pagesProjectEnv],
    routes,
    domains,
    workerCompatibilityDate:
      workerCompatibilityDate ?? env.CF_WORKER_COMPATIBILITY_DATE ?? defaultWorkerCompatibilityDate,
  };
}

export function createReleasePlan(options) {
  if (options.workerName && options.branch) {
    throw new Error('--branch is only supported for Pages deployments');
  }
  if (!options.skipCloudflare && !options.workerName && !options.pagesProject) {
    throw new Error(
      `Missing Cloudflare target. Pass --worker-name, --pages-project, or set ${releaseProfile.workerNameEnv} / ${releaseProfile.pagesProjectEnv}.`,
    );
  }

  const distDir = path.join(appDir, releaseProfile.distDir);
  const steps = [
    {
      id: 'build',
      label: `Build ${releaseProfile.appName}`,
      command: releaseProfile.buildCommand,
      cwd: appDir,
    },
    ...releaseProfile.testCommands.map((command, index) => ({
      id: `test-${index + 1}`,
      label: `Test ${releaseProfile.appName} (${index + 1}/${releaseProfile.testCommands.length})`,
      command,
      cwd: appDir,
    })),
    {
      id: 'publish',
      label: `Publish ${releaseProfile.appName} to hashtree`,
      command: [
        'cargo',
        'run',
        '--manifest-path',
        manifestPath,
        '-p',
        'hashtree-cli',
        '--bin',
        'htree',
        '--',
        'add',
        '.',
        '--publish',
        options.treeName,
      ],
      cwd: distDir,
    },
  ];

  if (!options.skipCloudflare) {
    const deployCommand = options.workerName
      ? wranglerWorkerAssetsCommand(
          '--assets',
          releaseProfile.distDir,
          '--name',
          options.workerName,
          '--compatibility-date',
          options.workerCompatibilityDate,
          '--keep-vars',
        )
      : wranglerPagesCommand(
          'pages',
          'deploy',
          releaseProfile.distDir,
          '--project-name',
          options.pagesProject,
        );
    if (options.workerName) {
      for (const route of options.routes ?? []) {
        deployCommand.push('--route', route);
      }
      for (const domain of options.domains ?? []) {
        deployCommand.push('--domain', domain);
      }
    }
    if (options.pagesProject && options.branch) {
      deployCommand.push('--branch', options.branch);
    }
    steps.push({
      id: 'deploy',
      label: options.workerName
        ? `Deploy ${releaseProfile.appName} to Cloudflare Worker`
        : `Deploy ${releaseProfile.appName} to Cloudflare Pages`,
      command: deployCommand,
      cwd: appDir,
    });
  }

  return { profile: releaseProfile, distDir, steps };
}

function defaultRunner(step) {
  const [command, ...args] = step.command;
  console.log(`\n==> ${step.label}`);
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
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

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function ensureDistExists(distDir, buildOutputExists = existsSync) {
  if (!buildOutputExists(distDir)) {
    throw new Error(`Build output directory not found: ${distDir}`);
  }
}

export function parsePublishOutput(output) {
  const nhashMatch = output.match(/nhash1[ac-hj-np-z02-9]+/i);
  if (!nhashMatch) {
    throw new Error('Publish succeeded but no nhash was found in htree output');
  }

  const publishedMatch = output.match(/^\s*published:\s+(\S+)\s*$/im);
  if (!publishedMatch) {
    throw new Error('Publish succeeded but no mutable ref was found in htree output');
  }

  return {
    nhash: nhashMatch[0],
    publishedRef: publishedMatch[1],
  };
}

function parsePagesOutput(output) {
  const pagesUrlMatch = output.match(/https:\/\/[^\s]+\.pages\.dev(?:\/[^\s]*)?/i);
  return pagesUrlMatch ? pagesUrlMatch[0] : null;
}

export function runRelease(options, runner = defaultRunner, hooks = {}) {
  const plan = createReleasePlan(options);
  const buildOutputExists = hooks.buildOutputExists ?? existsSync;

  if (options.dryRun) {
    return {
      dryRun: true,
      profile: plan.profile,
      steps: plan.steps,
    };
  }

  let publishOutput = '';
  let pagesOutput = '';
  for (const step of plan.steps) {
    const result = runner(step);
    if (result.status !== 0) {
      throw new Error(`${step.label} failed with exit code ${result.status}`);
    }
    if (step.id === 'build') {
      ensureDistExists(plan.distDir, buildOutputExists);
    }
    if (step.id === 'publish') {
      publishOutput = `${result.stdout}\n${result.stderr}`;
    }
    if (step.id === 'deploy') {
      pagesOutput = `${result.stdout}\n${result.stderr}`;
    }
  }

  const publish = parsePublishOutput(publishOutput);
  return {
    profile: plan.profile,
    treeName: options.treeName,
    publish,
    pagesUrl: pagesOutput ? parsePagesOutput(pagesOutput) : null,
    pagesProject:
      options.skipCloudflare || options.workerName ? null : options.pagesProject ?? null,
    workerName: options.skipCloudflare ? null : options.workerName ?? null,
    routes: options.skipCloudflare || !options.workerName ? [] : options.routes ?? [],
    domains: options.skipCloudflare || !options.workerName ? [] : options.domains ?? [],
  };
}

export function usage() {
  return `Usage: node ./scripts/release-site.mjs [options]

Build once, test the built output, publish to hashtree, then deploy that same
directory to Cloudflare Workers Static Assets or Cloudflare Pages.

Options:
  --worker-name <name>    Cloudflare Worker service name for static assets
  --pages-project <name>  Cloudflare Pages project name
  --tree <name>           hashtree mutable tree name override
  --route <pattern>       Worker route, for example hashtree.cc/*
  --domain <hostname>     Worker custom domain, for example hashtree.cc
  --branch <name>         Pages branch/preview deployment target
  --pages-only            disable the built-in/default Worker target and use Pages
  --compatibility-date    Worker compatibility date override
  --skip-cloudflare       publish to hashtree only
  --skip-pages            alias for --skip-cloudflare
  --dry-run               print planned steps without running them

Environment:
  ${releaseProfile.workerNameEnv}   Default Worker name for hashtree.cc
  ${releaseProfile.pagesProjectEnv}   Default Pages project for hashtree.cc
  CF_WORKER_COMPATIBILITY_DATE   Default compatibility date for Worker deployments
`;
}

function printSummary(result) {
  const { treeName, publish, pagesProject, pagesUrl, workerName, routes, domains } = result;
  console.log(`\n${releaseProfile.appName} release complete.`);
  console.log(`Hashtree immutable URL: htree://${publish.nhash}/index.html`);
  console.log(`Hashtree mutable URL: htree://${publish.publishedRef}`);
  console.log(`Hashtree owner URL: htree://${publish.publishedRef}`);
  if (workerName) {
    console.log(`Worker service: ${workerName}`);
  }
  for (const route of routes ?? []) {
    console.log(`Worker route: ${route}`);
  }
  for (const domain of domains ?? []) {
    console.log(`Worker custom domain: ${domain}`);
  }
  if (pagesProject) {
    console.log(`Pages project: ${pagesProject}`);
  }
  if (pagesUrl) {
    console.log(`Pages deployment: ${pagesUrl}`);
  }
  console.log(`Tree name: ${treeName}`);
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

    const result = runRelease(parsed);
    if (result.dryRun) {
      console.log(usage());
      for (const step of result.steps) {
        console.log(`${step.label}: ${step.command.join(' ')} (cwd: ${step.cwd})`);
      }
      process.exit(0);
    }
    printSummary(result);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
