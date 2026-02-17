import 'virtual:uno.css';
import App from './App.svelte';
import { mount } from 'svelte';
import { initWorkerClient } from './lib/workerClient';

void initWorkerClient();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
