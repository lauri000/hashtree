import 'virtual:uno.css';
import VideoApp from './VideoApp.svelte';
import { mount } from 'svelte';
import { initServiceWorker } from './lib/swInit';
import { restoreSession, initReadonlyBackend } from './nostr/auth';
import { mergeBootstrapIndex } from './stores/searchIndex';
import { setAppType } from './appType';
import { initHtreeApi } from './lib/htreeApi';
import { installHtreeDebugCapture } from './lib/htreeDebug';
import { ensureMediaStreamingReady } from './lib/mediaStreamingSetup';

setAppType('video');
installHtreeDebugCapture();

async function init() {
  const swPromise = initServiceWorker({ requireCrossOriginIsolation: true });
  await swPromise;
  const htreePromise = initHtreeApi();
  const backendPromise = initReadonlyBackend();
  const sessionPromise = restoreSession();
  await backendPromise;
  await ensureMediaStreamingReady().catch(() => false);
  mount(VideoApp, {
    target: document.getElementById('app')!,
  });
  await sessionPromise;
  await htreePromise;
  mergeBootstrapIndex().catch(() => {});
}

init();
if (import.meta.env.DEV && import.meta.env.VITE_TEST_MODE) {
  void import('./lib/testHelpers').then(({ setupTestHelpers }) => setupTestHelpers());
}
