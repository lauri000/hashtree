import 'virtual:uno.css';
import BoardsApp from './BoardsApp.svelte';
import { mount } from 'svelte';
import { initServiceWorker } from './lib/swInit';
import { restoreSession, initReadonlyBackend } from './nostr/auth';
import { setAppType } from './appType';
import { initHtreeApi } from './lib/htreeApi';

setAppType('boards');

async function init() {
  mount(BoardsApp, {
    target: document.getElementById('app')!,
  });
  await initServiceWorker();
  const htreePromise = initHtreeApi();
  const backendPromise = initReadonlyBackend();
  const sessionPromise = restoreSession();
  await Promise.all([backendPromise, sessionPromise]);
  await htreePromise;
}

init();
if (import.meta.env.DEV && import.meta.env.VITE_TEST_MODE) {
  void import('./lib/testHelpers.ts').then(({ setupTestHelpers }) => setupTestHelpers());
}
