<script lang="ts">
  import { settingsStore, DEFAULT_SETTINGS } from '../lib/settings';
  import { getStorageStats } from '../lib/workerClient';
  import { p2pStore, type P2PRelayStatus } from '../lib/p2p';
  import { minidenticon } from 'minidenticons';
  import { animalName } from '../lib/animalName';

  const MB = 1024 * 1024;

  let settings = $derived($settingsStore);
  let p2p = $derived($p2pStore);
  let connectedPeers = $derived(p2p.peers.filter((peer) => peer.connected));
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

  function serverLabel(url: string): string {
    return url.replace(/^https?:\/\//, '');
  }

  function peerAnimalName(pubkey: string): string {
    try {
      return animalName(pubkey);
    } catch {
      return 'Unknown Peer';
    }
  }

  function identiconUri(seed: string): string {
    return `data:image/svg+xml;utf8,${encodeURIComponent(minidenticon(seed, 50, 50))}`;
  }

  function buildLabel(): string {
    const buildTime = import.meta.env.VITE_BUILD_TIME;
    if (!buildTime || buildTime === 'undefined') return 'development';
    try {
      return new Date(buildTime).toLocaleString();
    } catch {
      return buildTime;
    }
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

<section class="py-8 space-y-6 max-w-3xl mx-auto w-full" data-testid="settings-page">
  <div class="bg-surface-1 rounded-xl p-5 space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="text-text-1 text-lg font-semibold">Peers ({connectedPeers.length})</h2>
    </div>
    <p class="text-text-3 text-sm">Currently connected WebRTC peers discovered via Nostr signaling relays</p>

    {#if p2p.pubkey}
      {@const myPeerName = peerAnimalName(p2p.pubkey)}
      <div class="bg-surface-0 border border-surface-3 rounded-lg p-3 flex items-center gap-3" title={p2p.pubkey}>
        <div class="rounded-full flex items-center justify-center shrink-0 bg-surface-3 w-8 h-8">
          <img src={identiconUri(p2p.pubkey)} alt="" width="24" height="24" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-text-3 text-xs">Your peer identity</div>
          <div class="text-text-1 text-sm font-medium truncate">{myPeerName}</div>
        </div>
      </div>
    {/if}

    {#if connectedPeers.length === 0}
      <div class="bg-surface-0 border border-surface-3 rounded-lg p-3 text-text-3 text-sm">
        No peers connected
      </div>
    {:else}
      <div class="space-y-2">
        {#each connectedPeers as peer (peer.peerId)}
          {@const peerStatusLabel = peer.connected ? 'Connected' : 'Connecting'}
          <div
            class="bg-surface-0 border border-surface-3 rounded-lg p-3 flex items-center gap-3"
            data-testid="settings-peer-item"
            title={peerStatusLabel + ' · ' + peer.pubkey}
          >
            <span
              class="w-2 h-2 rounded-full shrink-0"
              style={"background:" + (peer.connected ? '#2ba640' : '#f4bf4f')}
              title={peerStatusLabel}
            ></span>
            <div class="min-w-0 flex-1 flex items-center gap-2">
              <div class="rounded-full flex items-center justify-center shrink-0 bg-surface-3 w-8 h-8">
                <img src={identiconUri(peer.pubkey)} alt="" width="24" height="24" />
              </div>
              <div class="text-text-1 text-sm font-medium truncate">{peerAnimalName(peer.pubkey)}</div>
            </div>
            <div class="text-xs text-text-3 text-right">
              <div>↑ {formatBytes(peer.bytesSent)}</div>
              <div>↓ {formatBytes(peer.bytesReceived)}</div>
            </div>
            <div class="text-[11px] text-text-3 text-right font-mono">
              <div>q ↑{peer.requestsSent} ↓{peer.requestsReceived}</div>
              <div>r ↑{peer.responsesSent} ↓{peer.responsesReceived}</div>
              <div>fwd {peer.forwardedRequests} ok {peer.forwardedResolved}</div>
              <div>dup-supp {peer.forwardedSuppressed}</div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="bg-surface-1 rounded-xl p-5 space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="text-text-1 text-lg font-semibold">P2P Relays</h2>
    </div>
    <p class="text-text-3 text-sm">Nostr relays used to find and connect to WebRTC peers</p>

    <div class="space-y-2">
      {#each settings.network.relays as relay (relay)}
        {@const relayState = p2p.relays.find(entry => entry.url === relay)?.status ?? 'disconnected'}
        <div
          class="bg-surface-0 border border-surface-3 rounded-lg p-3 flex items-center gap-3"
          data-testid="settings-relay-item"
          title={relayStatusLabel(relayState)}
        >
          <span
            class="w-2 h-2 rounded-full shrink-0"
            style={"background:" + relayStatusColor(relayState)}
            data-testid={"settings-relay-status-" + relayState}
            title={relayStatusLabel(relayState)}
          ></span>
          <div class="min-w-0 flex-1">
            <div class="text-text-1 text-sm truncate">{relayHost(relay)}</div>
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
      <h2 class="text-text-1 text-lg font-semibold">Blossom Servers</h2>
      <button class="btn-ghost text-xs" onclick={() => settingsStore.reset()}>Reset All</button>
    </div>
    <p class="text-text-3 text-sm">
      HTTP fallback servers used when content is unavailable from WebRTC peers.
      <a
        href="https://github.com/hzrd149/blossom"
        target="_blank"
        rel="noopener noreferrer"
        class="text-accent underline ml-1"
        data-testid="settings-blossom-link"
      >
        Blossom
      </a>
    </p>

    <div class="grid grid-cols-2 gap-3 text-sm">
      <div class="bg-surface-0 rounded-lg p-3" data-testid="settings-blossom-upload-total">
        <div class="text-text-3 text-xs mb-1">Blossom Upload</div>
        <div class="text-text-1 font-medium">{formatBytes(p2p.blossomBandwidth.totalBytesSent)}</div>
      </div>
      <div class="bg-surface-0 rounded-lg p-3" data-testid="settings-blossom-download-total">
        <div class="text-text-3 text-xs mb-1">Blossom Download</div>
        <div class="text-text-1 font-medium">{formatBytes(p2p.blossomBandwidth.totalBytesReceived)}</div>
      </div>
    </div>

    <div class="space-y-2">
      {#each settings.network.blossomServers as server (server.url)}
        {@const usage = p2p.blossomBandwidth.servers.find(entry => entry.url === server.url)}
        <div class="bg-surface-0 border border-surface-3 rounded-lg p-3 flex items-center gap-3" data-testid="settings-server-item">
          <div class="min-w-0 flex-1">
            <div class="text-text-1 text-sm truncate" title={server.url}>{serverLabel(server.url)}</div>
            <div class="text-text-3 text-xs">
              ↑ {formatBytes(usage?.bytesSent ?? 0)} · ↓ {formatBytes(usage?.bytesReceived ?? 0)}
            </div>
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
    <h2 class="text-text-1 text-lg font-semibold">Header</h2>
    <label class="flex items-center justify-between gap-3 text-sm">
      <div>
        <div class="text-text-1">Show bandwidth indicator in header</div>
        <div class="text-text-3 text-xs">Display upload and download rates in the top bar</div>
      </div>
      <input
        type="checkbox"
        checked={settings.ui.showBandwidthIndicator}
        onchange={(e) => settingsStore.setShowBandwidthIndicator(e.currentTarget.checked)}
        class="accent-accent w-4 h-4"
        data-testid="settings-show-bandwidth-toggle"
      />
    </label>
  </div>

  <div class="bg-surface-1 rounded-xl p-5 space-y-3" data-testid="settings-app-info">
    <h2 class="text-text-1 text-lg font-semibold">About</h2>
    <p class="text-text-3 text-sm">Version and build information</p>

    <div class="bg-surface-0 rounded-lg p-3 text-sm space-y-2">
      <div class="flex justify-between items-center gap-3">
        <span class="text-text-3">Version</span>
        <span class="text-text-1 font-mono text-xs" data-testid="settings-app-version">{import.meta.env.VITE_APP_VERSION || 'development'}</span>
      </div>
      <div class="flex justify-between items-center gap-3">
        <span class="text-text-3">Build</span>
        <span class="text-text-1 font-mono text-xs" data-testid="settings-build-time">{buildLabel()}</span>
      </div>
    </div>

    <button
      onclick={() => window.location.reload()}
      class="btn-ghost w-full flex items-center justify-center gap-2"
      data-testid="settings-refresh-app"
    >
      <span class="i-lucide-refresh-cw text-sm"></span>
      <span>Refresh App</span>
    </button>
  </div>
</section>
