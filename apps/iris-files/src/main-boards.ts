import 'virtual:uno.css';
import BoardsApp from './BoardsApp.svelte';
import { mount } from 'svelte';
import { initServiceWorker } from './lib/swInit';
import { restoreSession, initReadonlyWorker } from './nostr/auth';
import { setAppType } from './appType';
import { initHtreeApi } from './lib/htreeApi';

setAppType('boards');

async function init() {
  mount(BoardsApp, {
    target: document.getElementById('app')!,
  });
  const swPromise = initServiceWorker();
  const htreePromise = initHtreeApi();
  const workerPromise = initReadonlyWorker();
  const sessionPromise = restoreSession();
  await swPromise;
  await Promise.all([workerPromise, sessionPromise]);
  await htreePromise;
}

init();
if (import.meta.env.DEV && import.meta.env.VITE_TEST_MODE) {
  void import('./lib/testHelpers').then(({ setupTestHelpers }) => setupTestHelpers());
}
