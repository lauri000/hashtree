import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const launcherPath = path.join(appDir, 'scripts', 'launch-linux-debug-iris.sh');
const artifactsDir = process.env.IRIS_NATIVE_ARTIFACT_DIR ?? path.join(appDir, 'test-results', 'native-video');
const webdriverPort = Number(process.env.TAURI_DRIVER_PORT ?? 4444);
const automationPort = Number(process.env.IRIS_AUTOMATION_PORT ?? 21977);
const webdriverBase = `http://127.0.0.1:${webdriverPort}`;
const automationBase = `http://127.0.0.1:${automationPort}/automation`;
const smokeUrl = process.env.IRIS_VIDEO_SMOKE_URL ?? 'htree://self/video/index.html?smoke=1';

let driverProcess = null;
let sessionId = null;

function fail(message) {
  throw new Error(message);
}

function parseLoadedThumbnailCount(summary) {
  if (typeof summary !== 'string') {
    return null;
  }
  const match = summary.match(/thumbs=(\d+)\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseVisibleThumbnailCount(summary) {
  if (typeof summary !== 'string') {
    return null;
  }
  const match = summary.match(/visible=(\d+)/);
  return match ? Number(match[1]) : null;
}

function which(binary) {
  const result = spawnSync('bash', ['-lc', `command -v ${binary}`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: appDir,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

async function request(method, pathname, body) {
  const response = await fetch(`${webdriverBase}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    fail(`${method} ${pathname} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitFor(fn, description, timeoutMs = 30000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (lastError) {
    throw lastError;
  }
  fail(`Timed out waiting for ${description}`);
}

async function getAutomationState() {
  const response = await fetch(`${automationBase}/state`);
  if (!response.ok) {
    fail(`automation state returned ${response.status}`);
  }
  return await response.json();
}

async function waitForAutomationState(predicate, description, timeoutMs = 30000) {
  return waitFor(async () => {
    const state = await getAutomationState();
    if (!predicate(state)) {
      fail(`waiting for ${description}, current state: ${JSON.stringify(state)}`);
    }
    return state;
  }, description, timeoutMs);
}

async function postAutomationCommand(command) {
  const response = await fetch(`${automationBase}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    const body = await response.text();
    fail(`automation command failed: ${response.status} ${body}`);
  }
}

async function createSession() {
  const payload = await request('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        'tauri:options': {
          application: launcherPath,
        },
      },
    },
  });

  sessionId = payload.value?.sessionId ?? payload.sessionId;
  if (!sessionId) {
    fail(`WebDriver did not return a session id: ${JSON.stringify(payload)}`);
  }
}

async function deleteSession() {
  if (!sessionId) {
    return;
  }
  try {
    await request('DELETE', `/session/${sessionId}`);
  } finally {
    sessionId = null;
  }
}

async function takeScreenshot(filename) {
  const payload = await request('GET', `/session/${sessionId}/screenshot`);
  const encoded = payload.value;
  if (!encoded) {
    fail('WebDriver screenshot response did not contain image data');
  }
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(artifactsDir, filename), Buffer.from(encoded, 'base64'));
}

function maybeReexecUnderXvfb() {
  if (process.env.DISPLAY || process.env.__IRIS_NATIVE_UNDER_XVFB === '1') {
    return;
  }
  const xvfbRun = which('xvfb-run');
  if (!xvfbRun) {
    fail('DISPLAY is not set and xvfb-run is not installed. Run this on Linux with Xvfb or inside a desktop-capable container.');
  }

  const result = spawnSync(
    xvfbRun,
    ['-a', process.execPath, __filename],
    {
      cwd: appDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        __IRIS_NATIVE_UNDER_XVFB: '1',
      },
    },
  );
  process.exit(result.status ?? 1);
}

function startTauriDriver(nativeDriverPath) {
  driverProcess = spawn(
    'tauri-driver',
    ['--port', String(webdriverPort), '--native-driver', nativeDriverPath],
    {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );

  driverProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[tauri-driver] ${chunk}`);
  });
  driverProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[tauri-driver] ${chunk}`);
  });
}

async function waitForWebDriver() {
  await waitFor(async () => {
    const response = await fetch(`${webdriverBase}/status`);
    if (!response.ok) {
      fail(`webdriver status returned ${response.status}`);
    }
    const payload = await response.json();
    if (!payload.value?.ready) {
      fail(`webdriver not ready: ${JSON.stringify(payload)}`);
    }
    return payload;
  }, 'tauri-driver to be ready');
}

async function main() {
  if (process.platform !== 'linux') {
    fail('This native smoke harness is Linux-only. Use the Docker wrapper or a Linux VM.');
  }

  maybeReexecUnderXvfb();

  const nativeDriverPath = which('WebKitWebDriver');
  if (!nativeDriverPath) {
    fail('WebKitWebDriver is required on Linux. Install the distro package that provides it, such as webkit2gtk-driver.');
  }

  if (!which('tauri-driver')) {
    fail('tauri-driver is not installed. Run: cargo install tauri-driver --locked');
  }

  run('pnpm', ['exec', 'tauri', 'build', '--debug', '--no-bundle']);
  startTauriDriver(nativeDriverPath);

  try {
    await waitForWebDriver();
    await createSession();

    await waitForAutomationState(
      (state) => state.shellReady === true && state.currentView === 'launcher',
      'Iris launcher to be ready',
      60000,
    );
    await takeScreenshot('video-smoke-launcher.png');

    await postAutomationCommand({ action: 'open_url', url: smokeUrl });

    await waitForAutomationState(
      (state) => {
        return state.currentView === 'webview' &&
          (state.currentUrl === smokeUrl || state.currentUrl.includes('/video/index.html'));
      },
      `Iris to open ${smokeUrl}`,
      60000,
    );
    await takeScreenshot('video-smoke-opened.png');

    let loadedState;
    try {
      loadedState = await waitForAutomationState(
        (state) => {
          const loadedThumbs = parseLoadedThumbnailCount(state.childMediaSummary);
          const visibleThumbs = parseVisibleThumbnailCount(state.childMediaSummary);
          return state.childPageLoadState === 'finished' &&
            state.childDocumentTitle === 'Iris Video' &&
            state.childBodyText.includes('Smoke image ready') &&
            state.childBodyText.includes('Smoke video ready') &&
            loadedThumbs !== null &&
            loadedThumbs >= 3 &&
            visibleThumbs !== null &&
            visibleThumbs >= 2 &&
            !state.childLastError;
        },
        'video smoke assets to load through the htree backend',
        120000,
      );
    } catch (error) {
      const failedState = await getAutomationState().catch(() => null);
      await takeScreenshot('video-smoke-failed.png').catch(() => {});
      if (failedState) {
        console.error('Video smoke failed state:', JSON.stringify(failedState));
      }
      throw error;
    }

    await takeScreenshot('video-smoke-loaded.png');
    console.log('Video smoke URL:', smokeUrl);
    console.log('Video smoke body text:', loadedState.childBodyText);
    console.log('Video smoke media summary:', loadedState.childMediaSummary);
    console.log('Video smoke page load URL:', loadedState.childPageLoadUrl);
    console.log(`Native video smoke passed. Screenshots written to ${artifactsDir}`);
  } finally {
    await deleteSession().catch(() => {});
    if (driverProcess) {
      driverProcess.kill('SIGTERM');
      driverProcess = null;
    }
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await deleteSession().catch(() => {});
  if (driverProcess) {
    driverProcess.kill('SIGTERM');
  }
  process.exit(1);
});
