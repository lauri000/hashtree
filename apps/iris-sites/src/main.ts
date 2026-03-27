import App from './App.svelte';
import { mount } from 'svelte';
import { initWorkerClient } from './lib/workerClient';
import { initServiceWorker } from './lib/swInit';
import { setupMediaStreaming } from './lib/mediaStreamingSetup';

async function initBackgroundServices(): Promise<void> {
  await initServiceWorker();
  await initWorkerClient();
  await setupMediaStreaming();
}

void initBackgroundServices();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
