<script lang="ts">
  import { onMount } from 'svelte';
  import BandwidthHistoryChart from './BandwidthHistoryChart.svelte';
  import {
    isAutostartEnabled,
    toggleAutostart,
    getHtreeServerUrl,
    getDaemonNetworkSettings,
    updateDaemonNetworkSettings,
    clearHistory,
    type DaemonBlossomServerSettings,
    type DaemonNetworkSettings,
  } from '../lib/tauri';
  import { distributedOwner } from '../lib/apps';
  import {
    advanceMeshBandwidthHistory,
    emptyDaemonMeshStatus,
    formatBandwidth,
    formatBytes,
    parseDaemonMeshStatus,
    shortIdentifier,
    type DaemonMeshStatus,
    type MeshBandwidthHistoryPoint,
    type MeshHistoryCursor,
    type MeshPeerInfo,
  } from '../lib/mesh';

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
  let meshStatus = $state<DaemonMeshStatus>(emptyDaemonMeshStatus());
  let meshBandwidthHistory = $state<MeshBandwidthHistoryPoint[]>([]);
  let meshHistoryCursor = $state<MeshHistoryCursor | null>(null);
  let meshUploadBandwidth = $state(0);
  let meshDownloadBandwidth = $state(0);
  let networkStatusLoaded = $state(false);
  let networkStatusError = $state('');
  let daemonNetworkSettings = $state<DaemonNetworkSettings>({
    webrtc: true,
    multicast: false,
    bluetooth: false,
    maxMulticastPeers: 0,
    maxBluetoothPeers: 0,
    multicastGroup: '239.255.42.98',
    multicastPort: 48555,
    relayUrls: [],
    blossomServers: [],
  });
  let daemonNetworkDraft = $state<DaemonNetworkSettings>({
    webrtc: true,
    multicast: false,
    bluetooth: false,
    maxMulticastPeers: 0,
    maxBluetoothPeers: 0,
    multicastGroup: '239.255.42.98',
    multicastPort: 48555,
    relayUrls: [],
    blossomServers: [],
  });
  let daemonNetworkLoaded = $state(false);
  let daemonNetworkBusy = $state(false);
  let daemonNetworkError = $state('');
  let daemonNetworkSaved = $state(false);
  let newRelayUrl = $state('');
  let newBlossomUrl = $state('');

  const buildLabel = (() => {
    const buildTime = import.meta.env.VITE_BUILD_TIME;
    if (!buildTime || buildTime === 'undefined') return 'development';
    try {
      return new Date(buildTime).toLocaleString();
    } catch {
      return buildTime;
    }
  })();

  onMount(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    void (async () => {
      autostart = await isAutostartEnabled();
      await refreshDaemonNetworkSettings();
      try {
        daemonUrl = await getHtreeServerUrl();
        await refreshNetworkStatus();
        interval = setInterval(() => {
          void refreshNetworkStatus();
        }, 1000);
      } catch {
        daemonUrl = '';
        networkStatusLoaded = true;
        networkStatusError = 'Embedded daemon unavailable';
      }
    })();

    return () => {
      if (interval) clearInterval(interval);
    };
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

  function cloneDaemonNetworkSettings(settings: DaemonNetworkSettings): DaemonNetworkSettings {
    return {
      ...settings,
      relayUrls: [...settings.relayUrls],
      blossomServers: settings.blossomServers.map((server) => ({ ...server })),
    };
  }

  function daemonNetworkSettingsEqual(a: DaemonNetworkSettings, b: DaemonNetworkSettings): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  let hasPendingDaemonNetworkChanges = $derived(
    !daemonNetworkSettingsEqual(daemonNetworkSettings, daemonNetworkDraft),
  );

  let configuredBlossomReadServers = $derived(
    daemonNetworkSettings.blossomServers.filter((server) => server.read).length,
  );

  async function refreshDaemonNetworkSettings() {
    try {
      const settings = await getDaemonNetworkSettings();
      daemonNetworkSettings = cloneDaemonNetworkSettings(settings);
      daemonNetworkDraft = cloneDaemonNetworkSettings(settings);
      daemonNetworkError = '';
    } catch (error) {
      daemonNetworkError = error instanceof Error ? error.message : 'Failed to load daemon network settings';
    } finally {
      daemonNetworkLoaded = true;
    }
  }

  async function refreshNetworkStatus() {
    if (!daemonUrl) {
      networkStatusLoaded = true;
      return;
    }

    try {
      const response = await fetch(`${daemonUrl}/api/status`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      const nextStatus = parseDaemonMeshStatus(payload);
      const sample = advanceMeshBandwidthHistory(
        meshHistoryCursor,
        meshBandwidthHistory,
        {
          totalBytesSent: nextStatus.totalBytesSent,
          totalBytesReceived: nextStatus.totalBytesReceived,
        },
        Date.now(),
      );
      meshStatus = nextStatus;
      meshHistoryCursor = sample.nextCursor;
      meshBandwidthHistory = sample.history;
      meshUploadBandwidth = sample.rates.uploadBps;
      meshDownloadBandwidth = sample.rates.downloadBps;
      networkStatusError = '';
    } catch (error) {
      networkStatusError = error instanceof Error ? error.message : 'Failed to load daemon status';
    } finally {
      networkStatusLoaded = true;
    }
  }

  function stateColor(state: MeshPeerInfo['state']): string {
    return state === 'connected' ? 'bg-success' : 'bg-surface-3';
  }

  function poolLabel(pool: MeshPeerInfo['pool']): string {
    return pool === 'follows' ? 'follow' : 'other';
  }

  function transportLabel(transport: string): string {
    return transport.toLowerCase();
  }

  function peerLabel(peer: MeshPeerInfo): string {
    return shortIdentifier(peer.pubkey || peer.peerId, 10, 6);
  }

  async function applyDaemonNetworkSettings(nextSettings: DaemonNetworkSettings) {
    daemonNetworkBusy = true;
    try {
      const applied = await updateDaemonNetworkSettings(nextSettings);
      daemonNetworkSettings = cloneDaemonNetworkSettings(applied);
      daemonNetworkDraft = cloneDaemonNetworkSettings(applied);
      daemonNetworkError = '';
      daemonNetworkSaved = true;
      setTimeout(() => {
        daemonNetworkSaved = false;
      }, 2000);
      await refreshNetworkStatus();
    } catch (error) {
      daemonNetworkError = error instanceof Error ? error.message : 'Failed to apply daemon network settings';
    } finally {
      daemonNetworkBusy = false;
      daemonNetworkLoaded = true;
    }
  }

  async function handleTransportToggle(
    key: keyof Pick<DaemonNetworkSettings, 'webrtc' | 'multicast' | 'bluetooth'>,
  ) {
    if (daemonNetworkBusy) return;

    const nextSettings = cloneDaemonNetworkSettings(daemonNetworkDraft);
    nextSettings[key] = !nextSettings[key];
    daemonNetworkDraft = nextSettings;
    await applyDaemonNetworkSettings(nextSettings);
  }

  function updateDaemonNetworkDraft(patch: Partial<DaemonNetworkSettings>) {
    daemonNetworkDraft = {
      ...daemonNetworkDraft,
      ...patch,
    };
    daemonNetworkSaved = false;
  }

  async function handleApplyDaemonNetworkSettings() {
    if (daemonNetworkBusy) return;
    await applyDaemonNetworkSettings(daemonNetworkDraft);
  }

  function isWebSocketUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    } catch {
      return false;
    }
  }

  function isHttpUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function addRelay() {
    const url = newRelayUrl.trim();
    if (!url || !isWebSocketUrl(url) || daemonNetworkDraft.relayUrls.includes(url)) return;
    updateDaemonNetworkDraft({
      relayUrls: [...daemonNetworkDraft.relayUrls, url],
    });
    newRelayUrl = '';
  }

  function removeRelay(url: string) {
    updateDaemonNetworkDraft({
      relayUrls: daemonNetworkDraft.relayUrls.filter((relay) => relay !== url),
    });
  }

  function addBlossomServer() {
    const url = newBlossomUrl.trim();
    if (
      !url ||
      !isHttpUrl(url) ||
      daemonNetworkDraft.blossomServers.some((server) => server.url === url)
    ) return;
    updateDaemonNetworkDraft({
      blossomServers: [
        ...daemonNetworkDraft.blossomServers,
        { url, read: true, write: false } satisfies DaemonBlossomServerSettings,
      ],
    });
    newBlossomUrl = '';
  }

  function removeBlossomServer(url: string) {
    updateDaemonNetworkDraft({
      blossomServers: daemonNetworkDraft.blossomServers.filter((server) => server.url !== url),
    });
  }

  function toggleBlossomMode(url: string, key: 'read' | 'write') {
    updateDaemonNetworkDraft({
      blossomServers: daemonNetworkDraft.blossomServers.map((server) =>
        server.url === url ? { ...server, [key]: !server[key] } : server,
      ),
    });
  }

  function updateNumericSetting(
    key: keyof Pick<DaemonNetworkSettings, 'maxMulticastPeers' | 'maxBluetoothPeers' | 'multicastPort'>,
    value: string,
  ) {
    const parsed = Number.parseInt(value, 10);
    daemonNetworkDraft = {
      ...daemonNetworkDraft,
      [key]: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
    };
    daemonNetworkSaved = false;
  }

  function formatConfigRelayLabel(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.host || url;
    } catch {
      return url;
    }
  }

  function formatCount(value: number, singular: string, plural: string): string {
    return `${value} ${value === 1 ? singular : plural}`;
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
        <div class="space-y-6">
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
              <div class="rounded bg-surface-1/70 p-2.5 space-y-2">
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <div class="text-sm font-medium text-text-1">Daemon network config</div>
                    <div class="text-xs text-text-3">
                      Saved to the embedded daemon config and hot-applied to the live peer router where supported
                    </div>
                  </div>
                  <div class="flex items-center gap-3">
                    {#if daemonNetworkBusy}
                      <span class="text-xs text-text-3">Applying…</span>
                    {:else if daemonNetworkSaved && !hasPendingDaemonNetworkChanges}
                      <span class="text-xs text-success">Saved</span>
                    {/if}
                    <button
                      class="rounded-lg px-3 py-2 text-sm text-text-1 transition-colors disabled:opacity-50 disabled:cursor-default {hasPendingDaemonNetworkChanges ? 'bg-surface-2 hover:bg-surface-3' : 'bg-surface-2'}"
                      onclick={() => void handleApplyDaemonNetworkSettings()}
                      disabled={!daemonNetworkLoaded || daemonNetworkBusy || !hasPendingDaemonNetworkChanges}
                    >
                      Apply
                    </button>
                  </div>
                </div>
                {#if daemonNetworkError}
                  <p class="text-xs text-text-3">{daemonNetworkError}</p>
                {/if}
              </div>
              <div class="flex items-center justify-between gap-4">
                <span class="text-sm text-text-3">Status</span>
                <span class="text-sm text-text-1">
                  {#if networkStatusError}
                    Degraded
                  {:else if networkStatusLoaded}
                    Running
                  {:else}
                    Loading
                  {/if}
                </span>
              </div>
            </div>
            {#if networkStatusError}
              <p class="mt-2 text-xs text-text-3">{networkStatusError}</p>
            {/if}
          </div>

          <div class="grid gap-3 lg:grid-cols-2">
            <div class="rounded bg-surface-2 p-3 space-y-3">
              <div>
                <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Nostr Relays</h3>
                <p class="text-xs text-text-3">
                  Used for signaling, graph sync, and relay-backed discovery.
                </p>
              </div>
              <div class="space-y-2">
                {#if daemonNetworkDraft.relayUrls.length === 0}
                  <div class="rounded bg-surface-1/70 px-3 py-2 text-sm text-text-3">
                    No relays configured
                  </div>
                {:else}
                  {#each daemonNetworkDraft.relayUrls as relayUrl (relayUrl)}
                    <div class="flex items-center gap-2 rounded bg-surface-1/70 px-3 py-2">
                      <div class="min-w-0 flex-1">
                        <div class="text-sm text-text-1 truncate">{formatConfigRelayLabel(relayUrl)}</div>
                        <div class="text-xs text-text-3 font-mono truncate">{relayUrl}</div>
                      </div>
                      <button
                        class="rounded p-2 text-text-3 hover:bg-surface-3 hover:text-text-1 transition-colors"
                        onclick={() => removeRelay(relayUrl)}
                        aria-label={`Remove relay ${relayUrl}`}
                      >
                        <span class="i-lucide-x text-sm"></span>
                      </button>
                    </div>
                  {/each}
                {/if}
              </div>
              <div class="flex gap-2">
                <input
                  class="min-w-0 flex-1 rounded-lg bg-surface-1 px-3 py-2 text-sm text-text-1 outline-none ring-0"
                  type="url"
                  placeholder="wss://relay.example"
                  value={newRelayUrl}
                  oninput={(event) => newRelayUrl = event.currentTarget.value}
                  aria-label="Add relay URL"
                />
                <button
                  class="rounded-lg bg-surface-1 px-3 py-2 text-sm text-text-1 hover:bg-surface-3 transition-colors disabled:opacity-50"
                  onclick={addRelay}
                  disabled={!newRelayUrl.trim()}
                >
                  Add
                </button>
              </div>
            </div>

            <div class="rounded bg-surface-2 p-3 space-y-3">
              <div>
                <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Blossom</h3>
                <p class="text-xs text-text-3">
                  Read and write fallback servers for blob fetches outside the local mesh.
                </p>
              </div>
              <div class="space-y-2">
                {#if daemonNetworkDraft.blossomServers.length === 0}
                  <div class="rounded bg-surface-1/70 px-3 py-2 text-sm text-text-3">
                    No Blossom servers configured
                  </div>
                {:else}
                  {#each daemonNetworkDraft.blossomServers as server (server.url)}
                    <div class="rounded bg-surface-1/70 px-3 py-2 space-y-2">
                      <div class="flex items-start gap-2">
                        <div class="min-w-0 flex-1">
                          <div class="text-sm text-text-1 truncate">{formatConfigRelayLabel(server.url)}</div>
                          <div class="text-xs text-text-3 font-mono truncate">{server.url}</div>
                        </div>
                        <button
                          class="rounded p-2 text-text-3 hover:bg-surface-3 hover:text-text-1 transition-colors"
                          onclick={() => removeBlossomServer(server.url)}
                          aria-label={`Remove Blossom server ${server.url}`}
                        >
                          <span class="i-lucide-x text-sm"></span>
                        </button>
                      </div>
                      <div class="flex flex-wrap gap-2">
                        <button
                          class="rounded px-2 py-1 text-xs transition-colors {server.read ? 'bg-accent/20 text-text-1' : 'bg-surface-2 text-text-3 hover:text-text-1'}"
                          onclick={() => toggleBlossomMode(server.url, 'read')}
                          aria-label={`Toggle Blossom read for ${server.url}`}
                        >
                          Read
                        </button>
                        <button
                          class="rounded px-2 py-1 text-xs transition-colors {server.write ? 'bg-accent/20 text-text-1' : 'bg-surface-2 text-text-3 hover:text-text-1'}"
                          onclick={() => toggleBlossomMode(server.url, 'write')}
                          aria-label={`Toggle Blossom write for ${server.url}`}
                        >
                          Write
                        </button>
                      </div>
                    </div>
                  {/each}
                {/if}
              </div>
              <div class="flex gap-2">
                <input
                  class="min-w-0 flex-1 rounded-lg bg-surface-1 px-3 py-2 text-sm text-text-1 outline-none ring-0"
                  type="url"
                  placeholder="https://cdn.example"
                  value={newBlossomUrl}
                  oninput={(event) => newBlossomUrl = event.currentTarget.value}
                  aria-label="Add Blossom server URL"
                />
                <button
                  class="rounded-lg bg-surface-1 px-3 py-2 text-sm text-text-1 hover:bg-surface-3 transition-colors disabled:opacity-50"
                  onclick={addBlossomServer}
                  disabled={!newBlossomUrl.trim()}
                >
                  Add
                </button>
              </div>
            </div>
          </div>

          <div>
            <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
              Peer Router
            </h3>
            <p class="text-xs text-text-3 mb-3">
              Nearby transports and offline routing settings for the embedded daemon.
            </p>
            <div class="rounded bg-surface-2 p-3 space-y-3">
              <div class="space-y-2">
                <label class="flex items-center justify-between gap-4 rounded bg-surface-1/70 px-3 py-2">
                  <div>
                    <div class="text-sm font-medium text-text-1">WebRTC</div>
                    <div class="text-xs text-text-3">Internet or relay-signaled direct peer links</div>
                  </div>
                  <button
                    class="relative h-6 w-11 rounded-full transition-colors {daemonNetworkDraft.webrtc ? 'bg-accent' : 'bg-surface-3'}"
                    onclick={() => void handleTransportToggle('webrtc')}
                    aria-label="Toggle WebRTC transport"
                    disabled={!daemonNetworkLoaded || daemonNetworkBusy}
                  >
                    <span class="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform {daemonNetworkDraft.webrtc ? 'translate-x-5' : ''}"></span>
                  </button>
                </label>
                <label class="flex items-center justify-between gap-4 rounded bg-surface-1/70 px-3 py-2">
                  <div>
                    <div class="text-sm font-medium text-text-1">LAN multicast</div>
                    <div class="text-xs text-text-3">Offline discovery, root updates, and local lookup replies</div>
                  </div>
                  <button
                    class="relative h-6 w-11 rounded-full transition-colors {daemonNetworkDraft.multicast ? 'bg-accent' : 'bg-surface-3'}"
                    onclick={() => void handleTransportToggle('multicast')}
                    aria-label="Toggle LAN multicast transport"
                    disabled={!daemonNetworkLoaded || daemonNetworkBusy}
                  >
                    <span class="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform {daemonNetworkDraft.multicast ? 'translate-x-5' : ''}"></span>
                  </button>
                </label>
                <label class="flex items-center justify-between gap-4 rounded bg-surface-1/70 px-3 py-2">
                  <div>
                    <div class="text-sm font-medium text-text-1">Bluetooth</div>
                    <div class="text-xs text-text-3">Nearby ad hoc peer sessions for offline exchange</div>
                  </div>
                  <button
                    class="relative h-6 w-11 rounded-full transition-colors {daemonNetworkDraft.bluetooth ? 'bg-accent' : 'bg-surface-3'}"
                    onclick={() => void handleTransportToggle('bluetooth')}
                    aria-label="Toggle Bluetooth transport"
                    disabled={!daemonNetworkLoaded || daemonNetworkBusy}
                  >
                    <span class="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform {daemonNetworkDraft.bluetooth ? 'translate-x-5' : ''}"></span>
                  </button>
                </label>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <label class="space-y-1">
                  <span class="text-xs uppercase tracking-wide text-text-3">Multicast Group</span>
                  <input
                    class="w-full rounded-lg bg-surface-1 px-3 py-2 text-sm text-text-1 outline-none ring-0"
                    type="text"
                    value={daemonNetworkDraft.multicastGroup}
                    oninput={(event) => updateDaemonNetworkDraft({ multicastGroup: event.currentTarget.value })}
                    aria-label="Multicast group"
                  />
                </label>
                <label class="space-y-1">
                  <span class="text-xs uppercase tracking-wide text-text-3">Multicast Port</span>
                  <input
                    class="w-full rounded-lg bg-surface-1 px-3 py-2 text-sm text-text-1 outline-none ring-0"
                    type="number"
                    min="0"
                    value={daemonNetworkDraft.multicastPort}
                    oninput={(event) => updateNumericSetting('multicastPort', event.currentTarget.value)}
                    aria-label="Multicast port"
                  />
                </label>
                <label class="space-y-1">
                  <span class="text-xs uppercase tracking-wide text-text-3">Max Multicast Peers</span>
                  <input
                    class="w-full rounded-lg bg-surface-1 px-3 py-2 text-sm text-text-1 outline-none ring-0"
                    type="number"
                    min="0"
                    value={daemonNetworkDraft.maxMulticastPeers}
                    oninput={(event) => updateNumericSetting('maxMulticastPeers', event.currentTarget.value)}
                    aria-label="Maximum multicast peers"
                  />
                </label>
                <label class="space-y-1">
                  <span class="text-xs uppercase tracking-wide text-text-3">Max Bluetooth Peers</span>
                  <input
                    class="w-full rounded-lg bg-surface-1 px-3 py-2 text-sm text-text-1 outline-none ring-0"
                    type="number"
                    min="0"
                    value={daemonNetworkDraft.maxBluetoothPeers}
                    oninput={(event) => updateNumericSetting('maxBluetoothPeers', event.currentTarget.value)}
                    aria-label="Maximum bluetooth peers"
                  />
                </label>
              </div>
            </div>
          </div>

          <div>
            <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
              Mesh
            </h3>
            <p class="text-xs text-text-3 mb-3">
              Nearby Bluetooth and WebRTC transport activity from the embedded daemon
            </p>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="rounded bg-surface-2 p-3">
                <div class="text-xs uppercase tracking-wide text-text-3">Peers</div>
                <div class="mt-1 text-lg font-semibold text-text-1">{meshStatus.connected} connected</div>
                <div class="mt-2 flex flex-wrap gap-2 text-xs text-text-3">
                  <span class="rounded bg-surface-1 px-2 py-1">{meshStatus.totalPeers} total</span>
                  <span class="rounded bg-surface-1 px-2 py-1">{meshStatus.withDataChannel} ready</span>
                </div>
              </div>

              <div class="rounded bg-surface-2 p-3">
                <div class="text-xs uppercase tracking-wide text-text-3">Transports</div>
                <div class="mt-1 flex flex-wrap gap-2 text-sm text-text-1">
                  <span class="rounded bg-surface-1 px-2 py-1">
                    {meshStatus.transportCounts.bluetooth ?? 0} bluetooth
                  </span>
                  <span class="rounded bg-surface-1 px-2 py-1">
                    {meshStatus.transportCounts.webrtc ?? 0} webrtc
                  </span>
                </div>
                <div class="mt-2 text-xs text-text-3">
                  {formatCount(configuredBlossomReadServers, 'blossom read server', 'blossom read servers')} · {formatCount(daemonNetworkSettings.relayUrls.length, 'relay', 'relays')}
                </div>
              </div>
            </div>

            <div class="mt-3 rounded bg-surface-2 p-3">
              <div class="grid grid-cols-2 gap-3 text-xs">
                <div class="flex items-center justify-between rounded bg-surface-1/70 px-2 py-2">
                  <span class="text-text-3">Upload</span>
                  <span class="font-mono text-success">{formatBandwidth(meshUploadBandwidth)}</span>
                </div>
                <div class="flex items-center justify-between rounded bg-surface-1/70 px-2 py-2">
                  <span class="text-text-3">Download</span>
                  <span class="font-mono text-accent">{formatBandwidth(meshDownloadBandwidth)}</span>
                </div>
                <div class="flex items-center justify-between rounded bg-surface-1/70 px-2 py-2">
                  <span class="text-text-3">Sent</span>
                  <span class="font-mono text-success">{formatBytes(meshStatus.totalBytesSent)}</span>
                </div>
                <div class="flex items-center justify-between rounded bg-surface-1/70 px-2 py-2">
                  <span class="text-text-3">Received</span>
                  <span class="font-mono text-accent">{formatBytes(meshStatus.totalBytesReceived)}</span>
                </div>
              </div>
              <div class="mt-3">
                <BandwidthHistoryChart history={meshBandwidthHistory} />
              </div>
            </div>
          </div>

          <div>
            <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
              Active Peers
            </h3>
            <p class="text-xs text-text-3 mb-3">Connected peers and transport byte counters</p>
            {#if meshStatus.peers.length === 0}
              <div class="rounded bg-surface-2 p-3 text-sm text-text-3">
                No mesh peers connected
              </div>
            {:else}
              <div class="bg-surface-2 rounded divide-y divide-surface-3">
                {#each meshStatus.peers as peer (peer.id)}
                  <div class="p-3">
                    <div class="flex items-center gap-2 text-sm">
                      <span class={`h-2 w-2 shrink-0 rounded-full ${stateColor(peer.state)}`}></span>
                      <span class="min-w-0 flex-1 font-medium text-text-1 truncate">
                        {peerLabel(peer)}
                      </span>
                      <span class="rounded bg-surface-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-3">
                        {transportLabel(peer.transport)}
                      </span>
                      <span class="rounded bg-surface-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-3">
                        {poolLabel(peer.pool)}
                      </span>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-3">
                      {#if peer.signalPaths.length > 0}
                        <span>{peer.signalPaths.join(' + ')}</span>
                      {/if}
                      <span class="font-mono">{shortIdentifier(peer.peerId, 8, 4)}</span>
                      <span class="text-success">
                        <span class="i-lucide-arrow-up inline-block align-middle mr-0.5"></span>{formatBytes(peer.bytesSent)}
                      </span>
                      <span class="text-accent">
                        <span class="i-lucide-arrow-down inline-block align-middle mr-0.5"></span>{formatBytes(peer.bytesReceived)}
                      </span>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
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
