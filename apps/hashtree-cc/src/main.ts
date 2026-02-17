import 'virtual:uno.css';
import App from './App.svelte';
import { mount } from 'svelte';
import { initWorkerClient } from './lib/workerClient';
import { initP2P } from './lib/p2p';

void initWorkerClient();
void initP2P();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
