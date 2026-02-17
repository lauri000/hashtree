<script lang="ts">
  import { settingsStore, DEFAULT_SETTINGS } from '../lib/settings';
  import { getStorageStats } from '../lib/workerClient';
  import { p2pStore, type P2PRelayStatus } from '../lib/p2p';

  const MB = 1024 * 1024;

  let settings = $derived($settingsStore);
  let p2p = $derived($p2pStore);
  let newServerUrl = $state('');
  let newRelayUrl = $state('');
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

  function addRelay() {
    const url = newRelayUrl.trim();
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
        return;
      }
      settingsStore.addRelay(parsed.toString());
      newRelayUrl = '';
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

  function relayStatusColor(status: P2PRelayStatus): string {
    switch (status) {
      case 'connected':
        return '#2ba640';
      case 'connecting':
        return '#f4bf4f';
      default:
        return '#ff5f56';
    }
  }

  function relayStatusLabel(status: P2PRelayStatus): string {
    switch (status) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting';
      default:
        return 'Disconnected';
    }
  }

  function relayHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  function shortPubkey(pubkey: string): string {
    if (pubkey.length <= 16) return pubkey;
    return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
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
      <h2 class="text-text-1 text-lg font-semibold">P2P Relays</h2>
    </div>
    <p class="text-text-3 text-sm">Nostr relays used for WebRTC peer signaling</p>

    <div class="space-y-2">
      {#each settings.network.relays as relay (relay)}
        {@const relayState = p2p.relays.find(entry => entry.url === relay)?.status ?? 'disconnected'}
        <div class="bg-surface-0 border border-surface-3 rounded-lg p-3 flex items-center gap-3" data-testid="settings-relay-item">
          <span
            class="w-2 h-2 rounded-full shrink-0"
            style={"background:" + relayStatusColor(relayState)}
            data-testid={"settings-relay-status-" + relayState}
            title={relayStatusLabel(relayState)}
          ></span>
          <div class="min-w-0 flex-1">
            <div class="text-text-1 text-sm truncate">{relayHost(relay)}</div>
            <div class="text-text-3 text-xs">{relayStatusLabel(relayState)}</div>
          </div>
          <button
            class="btn-ghost text-xs px-2 py-1 text-danger"
            onclick={() => settingsStore.removeRelay(relay)}
            title="Remove relay"
          >
            <span class="i-lucide-trash-2"></span>
          </button>
        </div>
      {/each}
    </div>

    <div class="flex gap-2">
      <input
        type="text"
        bind:value={newRelayUrl}
        placeholder="wss://relay.example.com"
        class="flex-1 bg-surface-0 text-text-1 border border-surface-3 rounded-lg px-3 py-2 text-sm"
        onkeydown={(e) => e.key === 'Enter' && addRelay()}
        data-testid="settings-new-relay"
      />
      <button class="btn-primary text-sm" onclick={addRelay} data-testid="settings-add-relay">Add</button>
    </div>
  </div>

  <div class="bg-surface-1 rounded-xl p-5 space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="text-text-1 text-lg font-semibold">Peers ({p2p.peers.length})</h2>
    </div>
    <p class="text-text-3 text-sm">Live WebRTC peers discovered via Nostr signaling relays</p>

    {#if p2p.peers.length === 0}
      <div class="bg-surface-0 border border-surface-3 rounded-lg p-3 text-text-3 text-sm">
        No peers connected
      </div>
    {:else}
      <div class="space-y-2">
        {#each p2p.peers as peer (peer.peerId)}
          <div class="bg-surface-0 border border-surface-3 rounded-lg p-3 flex items-center gap-3" data-testid="settings-peer-item">
            <span
              class="w-2 h-2 rounded-full shrink-0"
              style={"background:" + (peer.connected ? '#2ba640' : '#f4bf4f')}
            ></span>
            <div class="min-w-0 flex-1">
              <div class="text-text-1 text-sm font-mono truncate">{shortPubkey(peer.pubkey)}</div>
              <div class="text-text-3 text-xs">{peer.connected ? 'connected' : 'connecting'} · {peer.pool}</div>
            </div>
            <div class="text-xs text-text-3 text-right">
              <div>↑ {formatBytes(peer.bytesSent)}</div>
              <div>↓ {formatBytes(peer.bytesReceived)}</div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
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
            <span class="i-lucide-trash-2"></span>
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
