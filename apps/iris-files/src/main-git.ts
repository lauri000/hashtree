import 'virtual:uno.css';
import GitApp from './GitApp.svelte';
import { mount } from 'svelte';
import { initServiceWorker } from './lib/swInit';
import { restoreSession, initReadonlyBackend } from './nostr/auth';
import { setAppType } from './appType';
import { initHtreeApi } from './lib/htreeApi';
import { waitForRelayConnection } from './lib/workerInit';

setAppType('git');

async function init() {
  mount(GitApp, {
    target: document.getElementById('app')!,
  });
  const swPromise = initServiceWorker();
  await swPromise;
  const htreePromise = initHtreeApi();
  const backendPromise = initReadonlyBackend();
  const sessionPromise = restoreSession();
  await Promise.all([backendPromise, sessionPromise]);
  await htreePromise;
  await waitForRelayConnection();
}

init();
if (import.meta.env.DEV && import.meta.env.VITE_TEST_MODE) {
  void import('./lib/testHelpers').then(({ setupTestHelpers }) => setupTestHelpers());
}
