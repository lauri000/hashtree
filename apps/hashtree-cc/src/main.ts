import 'virtual:uno.css';
import App from './App.svelte';
import { mount } from 'svelte';
import { initWorkerClient } from './lib/workerClient';
import { initP2P } from './lib/p2p';
import { initServiceWorker } from './lib/swInit';
import { setupMediaStreaming } from './lib/mediaStreamingSetup';

async function initBackgroundServices(): Promise<void> {
  await initWorkerClient();
  await initServiceWorker();
  await setupMediaStreaming();
  await initP2P();
}

void initBackgroundServices();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
