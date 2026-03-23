<script lang="ts">
  import { onMount } from 'svelte';
  import {
    isAutostartEnabled,
    toggleAutostart,
    getHtreeServerUrl,
    clearHistory,
  } from '../lib/tauri';
  import { distributedOwner } from '../lib/apps';

  interface Props {
    onnavigate: (url: string) => void | Promise<void>;
  }

  type TabId = 'desktop' | 'privacy' | 'network' | 'about';

  const tabs = [
    { id: 'desktop', label: 'Desktop', icon: 'i-lucide-monitor' },
    { id: 'privacy', label: 'Privacy', icon: 'i-lucide-shield' },
    { id: 'network', label: 'Network', icon: 'i-lucide-server' },
    { id: 'about', label: 'About', icon: 'i-lucide-info' },
  ] as const satisfies ReadonlyArray<{ id: TabId; label: string; icon: string }>;

  const sourceLinks = [
    {
      label: 'Open hashtree repository',
      description: 'Browse the canonical repository in Iris Git',
      icon: 'i-lucide-git-branch',
      url: `htree://${distributedOwner}/git/#/${distributedOwner}/hashtree`,
    },
    {
      label: 'Open Iris app source',
      description: 'Jump straight to apps/iris in the repo',
      icon: 'i-lucide-app-window',
      url: `htree://${distributedOwner}/git/#/${distributedOwner}/hashtree/apps/iris`,
    },
  ] as const;

  let { onnavigate }: Props = $props();

  let activeTab = $state<TabId>('desktop');
  let autostart = $state(false);
  let daemonUrl = $state('');
  let historyCleared = $state(false);

  const buildLabel = (() => {
    const buildTime = import.meta.env.VITE_BUILD_TIME;
    if (!buildTime || buildTime === 'undefined') return 'development';
    try {
      return new Date(buildTime).toLocaleString();
    } catch {
      return buildTime;
    }
  })();

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

  async function handleClearHistory() {
    await clearHistory();
    historyCleared = true;
    setTimeout(() => {
      historyCleared = false;
    }, 2000);
  }

  function openSource(url: string) {
    void onnavigate(url);
  }
</script>

<div class="flex-1 flex flex-col overflow-hidden">
  <div class="shrink-0 border-b border-surface-2 bg-surface-1 px-4">
    <div class="mx-auto max-w-2xl py-5">
      <h1 class="text-2xl font-semibold text-text-1">Settings</h1>
      <p class="mt-1 text-sm text-text-3">
        Device behavior, local privacy controls, daemon details, and source links.
      </p>
    </div>
    <div class="mx-auto flex max-w-2xl gap-2 overflow-x-auto pb-3">
      {#each tabs as tab (tab.id)}
        <button
          onclick={() => activeTab = tab.id}
          class="shrink-0 rounded-xl px-4 py-2 text-sm font-medium transition-colors flex items-center gap-2
            {activeTab === tab.id
              ? 'bg-surface-3 text-text-1'
              : 'text-text-2 hover:bg-surface-2 hover:text-text-1'}"
        >
          <span class={tab.icon}></span>
          {tab.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="flex-1 overflow-auto">
    <div class="p-4 space-y-6 max-w-2xl mx-auto">
      {#if activeTab === 'desktop'}
        <div>
          <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
            Desktop App
          </h3>
          <p class="text-xs text-text-3 mb-3">Native shell behavior on this device</p>
          <div class="bg-surface-2 rounded divide-y divide-surface-3">
            <label class="flex items-center justify-between gap-4 p-3">
              <div>
                <div class="text-sm font-medium text-text-1">Launch at startup</div>
                <div class="text-xs text-text-3">Open Iris automatically when you log in</div>
              </div>
              <button
                class="relative h-6 w-11 rounded-full transition-colors {autostart ? 'bg-accent' : 'bg-surface-3'}"
                onclick={handleAutostartToggle}
                aria-label="Toggle launch at startup"
              >
                <span class="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform {autostart ? 'translate-x-5' : ''}"></span>
              </button>
            </label>
          </div>
        </div>
      {:else if activeTab === 'privacy'}
        <div>
          <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
            Browsing History
          </h3>
          <p class="text-xs text-text-3 mb-3">Shell-local history stored on this device</p>
          <div class="bg-surface-2 rounded p-3 flex items-center justify-between gap-4">
            <div>
              <div class="text-sm font-medium text-text-1">Browsing history</div>
              <div class="text-xs text-text-3">Clear saved addresses and recent visits</div>
            </div>
            {#if historyCleared}
              <span class="text-sm text-success font-medium">Cleared!</span>
            {:else}
              <button
                class="rounded-lg px-3 py-2 text-sm text-text-1 hover:bg-surface-3 transition-colors"
                onclick={handleClearHistory}
              >
                Clear history
              </button>
            {/if}
          </div>
        </div>
      {:else if activeTab === 'network'}
        <div>
          <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
            Daemon
          </h3>
          <p class="text-xs text-text-3 mb-3">Embedded htree server used by the shell</p>
          <div class="bg-surface-2 rounded p-3 space-y-3">
            <div class="flex items-center justify-between gap-4">
              <span class="text-sm text-text-3">Server URL</span>
              <span class="text-sm text-text-1 font-mono break-all text-right">
                {daemonUrl || 'Unavailable'}
              </span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span class="text-sm text-text-3">Transport</span>
              <span class="text-sm text-text-1">Embedded local daemon</span>
            </div>
          </div>
        </div>
      {:else if activeTab === 'about'}
        <div class="space-y-6">
          <div>
            <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
              About
            </h3>
            <p class="text-xs text-text-3 mb-3">Native shell for browsing distributed htree apps</p>
            <div class="bg-surface-2 rounded p-3 space-y-3 text-sm">
              <div class="flex items-center justify-between gap-4">
                <span class="text-text-3">Stack</span>
                <span class="text-text-1">Tauri + Svelte</span>
              </div>
              <div class="flex items-center justify-between gap-4">
                <span class="text-text-3">Build</span>
                <span class="text-text-1 font-mono text-xs text-right">{buildLabel}</span>
              </div>
            </div>
          </div>

          <div>
            <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
              Source Browser
            </h3>
            <p class="text-xs text-text-3 mb-3">Open the project in Iris Git over htree URLs</p>
            <div class="bg-surface-2 rounded divide-y divide-surface-3">
              {#each sourceLinks as link (link.url)}
                <button
                  class="w-full p-3 text-left hover:bg-surface-3 transition-colors flex items-start gap-3"
                  onclick={() => openSource(link.url)}
                >
                  <span class="{link.icon} mt-0.5 text-text-3 shrink-0"></span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium text-text-1">{link.label}</span>
                    <span class="block text-xs text-text-3 mt-1">{link.description}</span>
                    <span class="block text-xs text-text-3 font-mono mt-2 break-all">{link.url}</span>
                  </span>
                </button>
              {/each}
            </div>
          </div>

          <div>
            <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
              Actions
            </h3>
            <div class="bg-surface-2 rounded p-3">
              <button
                onclick={() => window.location.reload()}
                class="w-full rounded-lg px-3 py-2 text-sm text-text-1 hover:bg-surface-3 transition-colors flex items-center justify-center gap-2"
              >
                <span class="i-lucide-refresh-cw text-sm"></span>
                <span>Refresh App</span>
              </button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
