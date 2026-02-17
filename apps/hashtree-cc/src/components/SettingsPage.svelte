<script lang="ts">
  import { settingsStore, DEFAULT_SETTINGS } from '../lib/settings';
  import { getStorageStats } from '../lib/workerClient';

  const MB = 1024 * 1024;

  let settings = $derived($settingsStore);
  let newServerUrl = $state('');
  let storageStats = $state({ items: 0, bytes: 0, maxBytes: settingsStore.getState().storage.maxBytes });

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function addServer() {
    const url = newServerUrl.trim();
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return;
      }
      settingsStore.addBlossomServer(parsed.toString());
      newServerUrl = '';
    } catch {
      // Ignore invalid URL.
    }
  }

  function readWriteLabel(read?: boolean, write?: boolean): string {
    const modes: string[] = [];
    if (read ?? true) modes.push('read');
    if (write ?? false) modes.push('write');
    return modes.length > 0 ? modes.join(' + ') : 'disabled';
  }

  $effect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const stats = await getStorageStats();
        if (mounted) {
          storageStats = stats;
        }
      } catch {
        // Ignore startup errors while worker initializes.
      }
    };

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1500);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  });
</script>

<section class="py-8 space-y-6 max-w-3xl" data-testid="settings-page">
  <div class="bg-surface-1 rounded-xl p-5">
    <h2 class="text-text-1 text-lg font-semibold mb-3">App</h2>
    <label class="flex items-center justify-between gap-3">
      <span class="text-text-2 text-sm">Show connectivity indicator in header</span>
      <input
        type="checkbox"
        checked={settings.ui.showConnectivity}
        onchange={(e) => settingsStore.setShowConnectivity(e.currentTarget.checked)}
        class="accent-accent"
        data-testid="settings-show-connectivity"
      />
    </label>
  </div>

  <div class="bg-surface-1 rounded-xl p-5 space-y-3">
    <h2 class="text-text-1 text-lg font-semibold">Storage</h2>
    <p class="text-text-3 text-sm">Local IndexedDB cache size limit</p>
    <div class="grid grid-cols-2 gap-3 text-sm">
      <div class="bg-surface-0 rounded-lg p-3">
        <div class="text-text-3 text-xs mb-1">Items</div>
        <div class="text-text-1 font-medium">{storageStats.items.toLocaleString()}</div>
      </div>
      <div class="bg-surface-0 rounded-lg p-3">
        <div class="text-text-3 text-xs mb-1">Usage</div>
        <div class="text-text-1 font-medium">{formatBytes(storageStats.bytes)}</div>
      </div>
    </div>
    <label class="flex items-center gap-3 text-sm">
      <span class="text-text-2 whitespace-nowrap">Limit (MB)</span>
      <input
        type="number"
        min="100"
        max="10000"
        step="100"
        value={Math.round(settings.storage.maxBytes / MB)}
        onchange={(e) => settingsStore.setStorageLimitMb(parseInt(e.currentTarget.value, 10) || 1024)}
        class="bg-surface-0 text-text-1 border border-surface-3 rounded-lg px-3 py-2 w-42"
        data-testid="settings-storage-limit-mb"
      />
      <span class="text-text-3 text-xs">Current: {formatBytes(settings.storage.maxBytes)}</span>
    </label>
  </div>

  <div class="bg-surface-1 rounded-xl p-5 space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="text-text-1 text-lg font-semibold">Blossom Servers</h2>
      <button class="btn-ghost text-xs" onclick={() => settingsStore.reset()}>Reset All</button>
    </div>
    <p class="text-text-3 text-sm">Read/write storage backends for shared files</p>

    <div class="space-y-2">
      {#each settings.network.blossomServers as server (server.url)}
        <div class="bg-surface-0 border border-surface-3 rounded-lg p-3 flex items-center gap-3" data-testid="settings-server-item">
          <div class="min-w-0 flex-1">
            <div class="text-text-1 text-sm truncate">{server.url}</div>
            <div class="text-text-3 text-xs">{readWriteLabel(server.read, server.write)}</div>
          </div>
          <label class="text-xs text-text-3 flex items-center gap-1">
            <input
              type="checkbox"
              checked={server.read ?? true}
              onchange={() => settingsStore.toggleBlossomServerRead(server.url)}
              class="accent-accent"
            />
            read
          </label>
          <label class="text-xs text-text-3 flex items-center gap-1">
            <input
              type="checkbox"
              checked={server.write ?? false}
              onchange={() => settingsStore.toggleBlossomServerWrite(server.url)}
              class="accent-accent"
            />
            write
          </label>
          <button
            class="btn-ghost text-xs px-2 py-1 text-danger"
            onclick={() => settingsStore.removeBlossomServer(server.url)}
            title="Remove server"
          >
            remove
          </button>
        </div>
      {/each}
    </div>

    <div class="flex gap-2">
      <input
        type="text"
        bind:value={newServerUrl}
        placeholder="https://blossom.example.com"
        class="flex-1 bg-surface-0 text-text-1 border border-surface-3 rounded-lg px-3 py-2 text-sm"
        onkeydown={(e) => e.key === 'Enter' && addServer()}
        data-testid="settings-new-server"
      />
      <button class="btn-primary text-sm" onclick={addServer} data-testid="settings-add-server">Add</button>
    </div>
    <p class="text-text-3 text-xs">
      Default servers: {DEFAULT_SETTINGS.network.blossomServers.map(server => server.url).join(', ')}
    </p>
  </div>
</section>
