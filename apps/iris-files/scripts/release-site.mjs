import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const manifestPath = path.join(repoRoot, 'rust', 'Cargo.toml');
const defaultWorkerCompatibilityDate = '2026-03-19';
export const wranglerVersion = '4.78.0';

export const releaseProfiles = {
  files: {
    name: 'files',
    appName: 'Iris Files',
    distDir: 'dist',
    treeName: 'files',
    defaultWorkerName: 'iris-files',
    workerNameEnv: 'CF_WORKER_NAME_FILES',
    pagesProjectEnv: 'CF_PAGES_PROJECT_FILES',
    buildCommand: ['pnpm', 'run', 'build'],
    testCommands: [
      ['pnpm', 'exec', 'vitest', 'run', 'tests/filesPortableBuildConfig.test.ts'],
      ['node', './scripts/smoke-files-iris-portable.mjs'],
    ],
  },
  video: {
    name: 'video',
    appName: 'Iris Video',
    distDir: 'dist-video',
    treeName: 'video',
    defaultWorkerName: 'iris-video',
    defaultRoutes: ['video.iris.to/*'],
    workerNameEnv: 'CF_WORKER_NAME_VIDEO',
    pagesProjectEnv: 'CF_PAGES_PROJECT_VIDEO',
    buildCommand: ['pnpm', 'run', 'build:video'],
    testCommands: [
      ['pnpm', 'exec', 'vitest', 'run', 'tests/videoPortableBuildConfig.test.ts'],
      ['node', './scripts/smoke-video-iris-portable.mjs'],
    ],
  },
  docs: {
    name: 'docs',
    appName: 'Iris Docs',
    distDir: 'dist-docs',
    treeName: 'docs',
    defaultWorkerName: 'iris-docs',
    defaultRoutes: ['docs.iris.to/*'],
    workerNameEnv: 'CF_WORKER_NAME_DOCS',
    pagesProjectEnv: 'CF_PAGES_PROJECT_DOCS',
    buildCommand: ['pnpm', 'run', 'build:docs'],
    testCommands: [
      ['pnpm', 'exec', 'vitest', 'run', 'tests/docsPortableBuildConfig.test.ts'],
      ['node', './scripts/smoke-docs-iris-portable.mjs'],
    ],
  },
  git: {
    name: 'git',
    appName: 'Iris Git',
    distDir: 'iris-git',
    treeName: 'git',
    defaultWorkerName: 'iris-git',
    workerNameEnv: 'CF_WORKER_NAME_GIT',
    pagesProjectEnv: 'CF_PAGES_PROJECT_GIT',
    buildCommand: ['pnpm', 'run', 'build:git'],
    testCommands: [
      ['pnpm', 'exec', 'vitest', 'run', 'tests/gitPortableBuildConfig.test.ts'],
      ['node', './scripts/smoke-git-iris-portable.mjs'],
    ],
  },
  maps: {
    name: 'maps',
    appName: 'Iris Maps',
    distDir: 'dist-maps',
    treeName: 'maps',
    defaultWorkerName: 'iris-maps',
    defaultRoutes: ['maps.iris.to/*'],
    workerNameEnv: 'CF_WORKER_NAME_MAPS',
    pagesProjectEnv: 'CF_PAGES_PROJECT_MAPS',
    buildCommand: ['pnpm', 'run', 'build:maps'],
    testCommands: [
      ['pnpm', 'exec', 'vitest', 'run', 'tests/mapsPortableBuildConfig.test.ts'],
      ['node', './scripts/smoke-maps-iris-portable.mjs'],
    ],
  },
  boards: {
    name: 'boards',
    appName: 'Iris Boards',
    distDir: 'dist-boards',
    treeName: 'boards',
    defaultWorkerName: 'iris-boards',
    defaultDomains: ['boards.iris.to'],
    workerNameEnv: 'CF_WORKER_NAME_BOARDS',
    pagesProjectEnv: 'CF_PAGES_PROJECT_BOARDS',
    buildCommand: ['pnpm', 'run', 'build:boards'],
    testCommands: [
      ['pnpm', 'exec', 'vitest', 'run', 'tests/boardsPortableBuildConfig.test.ts'],
      ['node', './scripts/smoke-boards-iris-portable.mjs'],
    ],
  },
};

export const releaseProfileNames = Object.keys(releaseProfiles);

function cloneValues(values) {
  return values ? [...values] : [];
}

function usesBuiltInWorker(profile, workerName) {
  return Boolean(profile.defaultWorkerName && workerName === profile.defaultWorkerName);
}

function wranglerPagesCommand(...args) {
  return ['npx', `wrangler@${wranglerVersion}`, ...args];
}

function wranglerWorkerAssetsCommand(...args) {
  return ['npx', `wrangler@${wranglerVersion}`, 'deploy', ...args];
}

export function parseArgs(argv, env = process.env) {
  const args = [...argv].filter((arg, index) => !(arg === '--' && index === 0));
  const profileName = args.shift();
  if (!profileName || profileName === '-h' || profileName === '--help') {
    return { help: true };
  }

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
    if (arg === '--skip-cloudflare') {
      skipCloudflare = true;
      continue;
    }
    if (arg === '--skip-pages') {
      skipCloudflare = true;
      continue;
    }
    if (arg === '--pages-only') {
      pagesOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (profileName === 'all') {
    if (workerName) {
      throw new Error('--worker-name is not supported with the all profile');
    }
    if (pagesProject) {
      throw new Error('--pages-project is not supported with the all profile');
    }
    if (treeName) {
      throw new Error('--tree is not supported with the all profile');
    }
    if (routes.length > 0) {
      throw new Error('--route is not supported with the all profile');
    }
    if (domains.length > 0) {
      throw new Error('--domain is not supported with the all profile');
    }

    return {
      profileName,
      dryRun,
      skipCloudflare,
      pagesOnly,
      branch,
      workerCompatibilityDate,
    };
  }

  const profile = releaseProfiles[profileName];
  if (!profile) {
    throw new Error(`Unknown release profile: ${profileName}`);
  }
  if (pagesOnly && workerName) {
    throw new Error('--pages-only is not compatible with --worker-name');
  }
  if (pagesOnly && (routes.length > 0 || domains.length > 0)) {
    throw new Error('--pages-only is not compatible with --route/--domain');
  }

  const resolvedWorkerName = pagesOnly
    ? undefined
    : workerName ?? env[profile.workerNameEnv] ?? profile.defaultWorkerName;
  const defaultRoutes = usesBuiltInWorker(profile, resolvedWorkerName)
    ? cloneValues(profile.defaultRoutes)
    : [];
  const defaultDomains = usesBuiltInWorker(profile, resolvedWorkerName)
    ? cloneValues(profile.defaultDomains)
    : [];

  return {
    profileName,
    dryRun,
    skipCloudflare,
    branch,
    pagesOnly,
    treeName: treeName ?? profile.treeName,
    workerName: resolvedWorkerName,
    pagesProject: pagesProject ?? env[profile.pagesProjectEnv],
    routes: routes.length > 0 ? routes : defaultRoutes,
    domains: domains.length > 0 ? domains : defaultDomains,
    workerCompatibilityDate:
      workerCompatibilityDate ?? env.CF_WORKER_COMPATIBILITY_DATE ?? defaultWorkerCompatibilityDate,
  };
}

export function createReleasePlan(options) {
  const profile = releaseProfiles[options.profileName];
  if (!profile) {
    throw new Error(`Unknown release profile: ${options.profileName}`);
  }
  if (options.workerName && options.branch) {
    throw new Error('--branch is only supported for Pages deployments');
  }
  if (!options.skipCloudflare && !options.workerName && !options.pagesProject) {
    throw new Error(
      `Missing Cloudflare target. Pass --worker-name, --pages-project, or set ${profile.workerNameEnv} / ${profile.pagesProjectEnv}.`,
    );
  }

  const distDir = path.join(appDir, profile.distDir);
  const steps = [
    {
      id: 'build',
      label: `Build ${profile.appName}`,
      command: profile.buildCommand,
      cwd: appDir,
    },
    ...profile.testCommands.map((command, index) => ({
      id: `test-${index + 1}`,
      label: `Test ${profile.appName} (${index + 1}/${profile.testCommands.length})`,
      command,
      cwd: appDir,
    })),
    {
      id: 'publish',
      label: `Publish ${profile.appName} to hashtree`,
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
          profile.distDir,
          '--name',
          options.workerName,
          '--compatibility-date',
          options.workerCompatibilityDate,
          '--keep-vars',
        )
      : wranglerPagesCommand(
          'pages',
          'deploy',
          profile.distDir,
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
        ? `Deploy ${profile.appName} to Cloudflare Worker`
        : `Deploy ${profile.appName} to Cloudflare Pages`,
      command: deployCommand,
      cwd: appDir,
    });
  }

  return { profile, distDir, steps };
}

function defaultRunner(step) {
  const [command, ...args] = step.command;
  console.log(`\n==> ${step.label}`);
  console.log(`$ ${[command, ...args].join(' ')}`);

  const suppressDisplayPatterns = step.id === 'publish'
    ? [/^\s*hash:\s+/i, /^\s*key:\s+/i]
    : [];

  function createOutputWriter(stream) {
    let pending = '';

    return {
      write(chunk) {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';

        for (const line of lines) {
          if (!suppressDisplayPatterns.some((pattern) => pattern.test(line))) {
            stream.write(`${line}\n`);
          }
        }
      },
      flush() {
        if (!pending) return;
        if (!suppressDisplayPatterns.some((pattern) => pattern.test(pending))) {
          stream.write(pending);
        }
        pending = '';
      },
    };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: step.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const stdoutWriter = createOutputWriter(process.stdout);
    const stderrWriter = createOutputWriter(process.stderr);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      stdoutWriter.write(chunk);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      stderrWriter.write(chunk);
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      stdoutWriter.flush();
      stderrWriter.flush();
      if (signal) {
        const signalMessage = `Process exited with signal ${signal}\n`;
        stderr += signalMessage;
        process.stderr.write(signalMessage);
      }
      resolve({
        status: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
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

function isReleaseStep(step) {
  return step.id === 'publish' || step.id === 'deploy';
}

function assertStepSucceeded(step, result) {
  if (result.status !== 0) {
    throw new Error(`${step.label} failed with exit code ${result.status}`);
  }
}

export async function runRelease(options, runner = defaultRunner, hooks = {}) {
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
  const prereleaseSteps = plan.steps.filter((step) => !isReleaseStep(step));
  const releaseSteps = plan.steps.filter(isReleaseStep);

  for (const step of prereleaseSteps) {
    const result = await runner(step);
    assertStepSucceeded(step, result);
    if (step.id === 'build') {
      ensureDistExists(plan.distDir, buildOutputExists);
    }
  }

  const releaseResults = await Promise.allSettled(
    releaseSteps.map((step) => Promise.resolve().then(() => runner(step))),
  );

  for (const [index, execution] of releaseResults.entries()) {
    const step = releaseSteps[index];
    if (execution.status === 'rejected') {
      throw execution.reason;
    }
    const result = execution.value;
    assertStepSucceeded(step, result);
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

export async function runAllReleases(options, runner = defaultRunner, hooks = {}) {
  const profiles = releaseProfileNames.map((profileName) =>
    parseArgs(
      [
        profileName,
        ...(options.branch ? ['--branch', options.branch] : []),
        ...(options.pagesOnly ? ['--pages-only'] : []),
        ...(options.skipCloudflare ? ['--skip-cloudflare'] : []),
        ...(options.dryRun ? ['--dry-run'] : []),
        ...(options.workerCompatibilityDate
          ? ['--compatibility-date', options.workerCompatibilityDate]
          : []),
      ],
      process.env,
    ),
  );

  const results = [];
  for (const profile of profiles) {
    results.push(await runRelease(profile, runner, hooks));
  }

  return {
    ...(options.dryRun ? { dryRun: true } : {}),
    profiles: results,
  };
}

export function usage() {
  return `Usage: node ./scripts/release-site.mjs <files|video|docs|git|maps|boards|all> [options]

Build once, test the built output, then publish to hashtree and deploy that same
directory to Cloudflare Workers Static Assets or Cloudflare Pages in parallel.

Options:
  --worker-name <name>    Cloudflare Worker service name for static assets
  --pages-project <name>  Cloudflare Pages project name
  --tree <name>           hashtree mutable tree name override
  --route <pattern>       Worker route, for example video.iris.to/*
  --domain <hostname>     Worker custom domain, for example boards.iris.to
  --branch <name>         Pages branch/preview deployment target
  --pages-only            disable the built-in/default Worker target and use Pages
  --compatibility-date    Worker compatibility date override
  --skip-cloudflare       publish to hashtree only
  --skip-pages            alias for --skip-cloudflare
  --dry-run               print planned steps without running them

Environment:
  ${releaseProfiles.files.workerNameEnv}   Default Worker name for the files profile
  ${releaseProfiles.files.pagesProjectEnv}   Default Pages project for the files profile
  ${releaseProfiles.video.workerNameEnv}   Default Worker name for the video profile
  ${releaseProfiles.video.pagesProjectEnv}   Default Pages project for the video profile
  ${releaseProfiles.docs.workerNameEnv}   Default Worker name for the docs profile
  ${releaseProfiles.docs.pagesProjectEnv}   Default Pages project for the docs profile
  ${releaseProfiles.git.workerNameEnv}   Default Worker name for the git profile
  ${releaseProfiles.git.pagesProjectEnv}   Default Pages project for the git profile
  ${releaseProfiles.maps.workerNameEnv}   Default Worker name for the maps profile
  ${releaseProfiles.maps.pagesProjectEnv}   Default Pages project for the maps profile
  ${releaseProfiles.boards.workerNameEnv}   Default Worker name for the boards profile
  ${releaseProfiles.boards.pagesProjectEnv}   Default Pages project for the boards profile
  CF_WORKER_COMPATIBILITY_DATE   Default compatibility date for Worker deployments
`;
}

function printSummary(result) {
  const { profile, treeName, publish, pagesProject, pagesUrl, workerName, routes, domains } = result;
  console.log(`\n${profile.appName} release complete.`);
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

function printAllSummaries(results) {
  for (const result of results.profiles) {
    printSummary(result);
  }
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  return path.resolve(process.argv[1]) === __filename;
}

if (isMainModule()) {
  const main = async () => {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(usage());
      process.exit(0);
    }

    const result =
      parsed.profileName === 'all' ? await runAllReleases(parsed) : await runRelease(parsed);
    if (result.dryRun) {
      console.log(usage());
      if (parsed.profileName === 'all') {
        for (const profileResult of result.profiles) {
          console.log(`\n[${profileResult.profile.name}]`);
          for (const step of profileResult.steps) {
            console.log(`${step.label}: ${step.command.join(' ')} (cwd: ${step.cwd})`);
          }
        }
      } else {
        for (const step of result.steps) {
          console.log(`${step.label}: ${step.command.join(' ')} (cwd: ${step.cwd})`);
        }
      }
      process.exit(0);
    }
    if (parsed.profileName === 'all') {
      printAllSummaries(result);
    } else {
      printSummary(result);
    }
  };

  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
