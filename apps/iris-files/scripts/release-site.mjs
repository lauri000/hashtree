import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const manifestPath = path.join(repoRoot, 'rust', 'Cargo.toml');

export const releaseProfiles = {
  files: {
    name: 'files',
    appName: 'Iris Files',
    distDir: 'dist',
    treeName: 'files',
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
    pagesProjectEnv: 'CF_PAGES_PROJECT_DOCS',
    buildCommand: ['pnpm', 'run', 'build:docs'],
    testCommands: [
      ['pnpm', 'exec', 'vitest', 'run', 'tests/docsPortableBuildConfig.test.ts'],
      ['node', './scripts/smoke-docs-iris-portable.mjs'],
    ],
  },
  maps: {
    name: 'maps',
    appName: 'Iris Maps',
    distDir: 'dist-maps',
    treeName: 'maps',
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
    pagesProjectEnv: 'CF_PAGES_PROJECT_BOARDS',
    buildCommand: ['pnpm', 'run', 'build:boards'],
    testCommands: [
      ['pnpm', 'exec', 'vitest', 'run', 'tests/boardsPortableBuildConfig.test.ts'],
      ['node', './scripts/smoke-boards-iris-portable.mjs'],
    ],
  },
};

export const releaseProfileNames = Object.keys(releaseProfiles);

function wranglerPagesCommand(...args) {
  return ['npx', 'wrangler@4', ...args];
}

export function parseArgs(argv, env = process.env) {
  const args = [...argv].filter((arg, index) => !(arg === '--' && index === 0));
  const profileName = args.shift();
  if (!profileName || profileName === '-h' || profileName === '--help') {
    return { help: true };
  }

  let pagesProject;
  let treeName;
  let branch;
  let dryRun = false;
  let skipPages = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--') {
      continue;
    }
    if (arg === '--pages-project') {
      pagesProject = args.shift();
      continue;
    }
    if (arg === '--tree') {
      treeName = args.shift();
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
    if (arg === '--skip-pages') {
      skipPages = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (profileName === 'all') {
    if (pagesProject) {
      throw new Error('--pages-project is not supported with the all profile');
    }
    if (treeName) {
      throw new Error('--tree is not supported with the all profile');
    }

    return {
      profileName,
      dryRun,
      skipPages,
      branch,
    };
  }

  const profile = releaseProfiles[profileName];
  if (!profile) {
    throw new Error(`Unknown release profile: ${profileName}`);
  }

  return {
    profileName,
    dryRun,
    skipPages,
    branch,
    treeName: treeName ?? profile.treeName,
    pagesProject: pagesProject ?? env[profile.pagesProjectEnv],
  };
}

export function createReleasePlan(options) {
  const profile = releaseProfiles[options.profileName];
  if (!profile) {
    throw new Error(`Unknown release profile: ${options.profileName}`);
  }
  if (!options.skipPages && !options.pagesProject) {
    throw new Error(
      `Missing Pages project. Pass --pages-project or set ${profile.pagesProjectEnv}.`,
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

  if (!options.skipPages) {
    const deployCommand = wranglerPagesCommand(
      'pages',
      'deploy',
      profile.distDir,
      '--project-name',
      options.pagesProject,
    );
    if (options.branch) {
      deployCommand.push('--branch', options.branch);
    }
    steps.push({
      id: 'deploy',
      label: `Deploy ${profile.appName} to Cloudflare Pages`,
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
    pagesProject: options.skipPages ? null : options.pagesProject,
  };
}

export function runAllReleases(options, runner = defaultRunner, hooks = {}) {
  const profiles = releaseProfileNames.map((profileName) =>
    parseArgs(
      [
        profileName,
        ...(options.branch ? ['--branch', options.branch] : []),
        ...(options.skipPages ? ['--skip-pages'] : []),
        ...(options.dryRun ? ['--dry-run'] : []),
      ],
      process.env,
    ),
  );

  if (options.dryRun) {
    return {
      dryRun: true,
      profiles: profiles.map((profile) => runRelease(profile, runner, hooks)),
    };
  }

  return {
    profiles: profiles.map((profile) => runRelease(profile, runner, hooks)),
  };
}

export function usage() {
  return `Usage: node ./scripts/release-site.mjs <files|video|docs|maps|boards|all> [options]

Build once, test the built output, publish to hashtree, then deploy that same
directory to Cloudflare Pages.

Options:
  --pages-project <name>  Cloudflare Pages project name
  --tree <name>           hashtree mutable tree name override
  --branch <name>         Pages branch/preview deployment target
  --skip-pages            publish to hashtree only
  --dry-run               print planned steps without running them

Environment:
  ${releaseProfiles.files.pagesProjectEnv}   Default Pages project for the files profile
  ${releaseProfiles.video.pagesProjectEnv}   Default Pages project for the video profile
  ${releaseProfiles.docs.pagesProjectEnv}   Default Pages project for the docs profile
  ${releaseProfiles.maps.pagesProjectEnv}   Default Pages project for the maps profile
  ${releaseProfiles.boards.pagesProjectEnv}   Default Pages project for the boards profile
`;
}

function printSummary(result) {
  const { profile, treeName, publish, pagesProject, pagesUrl } = result;
  console.log(`\n${profile.appName} release complete.`);
  console.log(`Hashtree immutable URL: htree://${publish.nhash}/index.html`);
  console.log(`Hashtree mutable URL: htree://${publish.publishedRef}`);
  console.log(`Hashtree owner URL: htree://${publish.publishedRef}`);
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
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(usage());
      process.exit(0);
    }

    const result =
      parsed.profileName === 'all' ? runAllReleases(parsed) : runRelease(parsed);
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
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
