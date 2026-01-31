<script lang="ts">
  import { onMount } from 'svelte';
  import {
    isAutostartEnabled,
    toggleAutostart,
    getHtreeServerUrl,
  } from '../lib/tauri';

  let autostart = $state(false);
  let daemonUrl = $state('');

  onMount(async () => {
    autostart = await isAutostartEnabled();
    try {
      daemonUrl = await getHtreeServerUrl();
    } catch {
      daemonUrl = '';
    }
  });

  async function handleAutostartToggle() {
    const newValue = !autostart;
    const ok = await toggleAutostart(newValue);
    if (ok) autostart = newValue;
  }
</script>

<div class="flex-1 p-8 md:p-12 overflow-auto">
  <div class="max-w-2xl mx-auto">
    <h1 class="text-2xl font-semibold text-text-1 mb-8">Settings</h1>

    <section class="mb-8">
      <h2 class="text-lg font-semibold text-text-1 mb-4">Desktop App</h2>
      <div class="flex flex-col gap-4">
        <label class="flex items-center justify-between p-4 bg-surface-1 rounded-xl">
          <div>
            <div class="text-sm font-medium text-text-1">Launch at startup</div>
            <div class="text-xs text-text-3">Open Iris automatically when you log in</div>
          </div>
          <button
            class="w-11 h-6 rounded-full transition-colors {autostart ? 'bg-accent' : 'bg-surface-3'} relative"
            onclick={handleAutostartToggle}
            aria-label="Toggle launch at startup"
          >
            <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform {autostart ? 'translate-x-5' : ''}"></span>
          </button>
        </label>
      </div>
    </section>

    {#if daemonUrl}
      <section class="mb-8">
        <h2 class="text-lg font-semibold text-text-1 mb-4">Daemon</h2>
        <div class="p-4 bg-surface-1 rounded-xl">
          <div class="text-sm font-medium text-text-1 mb-1">Server URL</div>
          <div class="text-xs text-text-3 font-mono">{daemonUrl}</div>
        </div>
      </section>
    {/if}

    <section>
      <h2 class="text-lg font-semibold text-text-1 mb-4">About</h2>
      <div class="p-4 bg-surface-1 rounded-xl">
        <div class="text-sm text-text-2">
          Iris — a native browser for the decentralized web.
        </div>
        <div class="text-xs text-text-3 mt-2">
          Built with Tauri + Svelte
        </div>
      </div>
    </section>
  </div>
</div>
