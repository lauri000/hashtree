<script lang="ts">
  import { nip19 } from 'nostr-tools';
  import { nostrStore } from '../../nostr';
  import { settingsStore } from '../../stores/settings';
  import { appStore, formatBytes, refreshWebRTCStats, getLifetimeStats, blockPeer, unblockPeer, getWebRTCStore } from '../../store';
  import { UserRow } from '../User';

  // Pool settings
  let poolSettings = $derived($settingsStore.pools);

  // Peers
  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let appState = $derived($appStore);
  let peerList = $derived(appState.peers
    .filter(p => p.state === 'connected')
    .map(p => ({
      peerId: p.peerId,
      pubkey: p.pubkey,
      state: p.state,
      pool: p.pool,
      bytesSent: p.bytesSent,
      bytesReceived: p.bytesReceived,
    })));
  let webrtcStats = $derived({
    bytesSent: peerList.reduce((sum, p) => sum + p.bytesSent, 0),
    bytesReceived: peerList.reduce((sum, p) => sum + p.bytesReceived, 0),
  });
  type PeerDiagnostics = {
    bytesSent: number;
    bytesReceived: number;
    requestsSent: number;
    requestsReceived: number;
    responsesSent: number;
    responsesReceived: number;
    forwardedRequests: number;
    forwardedResolved: number;
    forwardedSuppressed: number;
  };
  let perPeerStats = $state(new Map<string, PeerDiagnostics>());
  let lifetimeStats = $derived.by(() => {
    webrtcStats;
    return getLifetimeStats();
  });
  let blockedPeers = $derived($settingsStore.blockedPeers ?? []);

  // Refresh stats periodically
  $effect(() => {
    const syncDiagnostics = async () => {
      refreshWebRTCStats();
      try {
        const stats = await getWebRTCStore().getStats();
        perPeerStats = new Map(
          Array.from(stats.perPeer.entries()).map(([peerId, peer]) => [peerId, {
            bytesSent: peer.bytesSent,
            bytesReceived: peer.bytesReceived,
            requestsSent: peer.requestsSent,
            requestsReceived: peer.requestsReceived,
            responsesSent: peer.responsesSent,
            responsesReceived: peer.responsesReceived,
            forwardedRequests: peer.forwardedRequests,
            forwardedResolved: peer.forwardedResolved,
            forwardedSuppressed: peer.forwardedSuppressed,
          }])
        );
      } catch {
        // Worker not ready yet
      }
    };

    syncDiagnostics();
    const interval = setInterval(syncDiagnostics, 1000);
    return () => clearInterval(interval);
  });

  function getPeerUuid(peerId: string): string {
    return peerId.split(':')[1] || peerId;
  }

  function stateColor(state: string): string {
    switch (state) {
      case 'connected': return '#3fb950';
      case 'connecting': return '#d29922';
      case 'failed': return '#f85149';
      default: return '#8b949e';
    }
  }

  function getPeerStats(peerId: string) {
    return perPeerStats?.get(peerId);
  }
</script>

<div class="p-4 space-y-6 max-w-2xl mx-auto">
  <!-- WebRTC Pool Settings -->
  <div>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
      Connection Pools
    </h3>
    <p class="text-xs text-text-3 mb-3">Max peer connections by category</p>
    <div class="bg-surface-2 rounded divide-y divide-surface-3">
      <div class="p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm text-text-1">Follows</span>
          <span class="text-xs text-text-3">Peers you follow</span>
        </div>
        <div class="grid grid-cols-2 gap-3 text-sm">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-text-3">Max</span>
            <input
              type="number"
              min="1"
              max="100"
              value={poolSettings.followsMax}
              onchange={(e) => settingsStore.setPoolSettings({ followsMax: parseInt(e.currentTarget.value) || 20 })}
              class="input text-sm"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-text-3">Satisfied</span>
            <input
              type="number"
              min="1"
              max="100"
              value={poolSettings.followsSatisfied}
              onchange={(e) => settingsStore.setPoolSettings({ followsSatisfied: parseInt(e.currentTarget.value) || 10 })}
              class="input text-sm"
            />
          </label>
        </div>
      </div>
      <div class="p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm text-text-1">Others</span>
          <span class="text-xs text-text-3">Other peers</span>
        </div>
        <div class="grid grid-cols-2 gap-3 text-sm">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-text-3">Max</span>
            <input
              type="number"
              min="0"
              max="100"
              value={poolSettings.otherMax}
              onchange={(e) => { const v = parseInt(e.currentTarget.value); settingsStore.setPoolSettings({ otherMax: isNaN(v) ? 10 : v }); }}
              class="input text-sm"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-text-3">Satisfied</span>
            <input
              type="number"
              min="0"
              max="100"
              value={poolSettings.otherSatisfied}
              onchange={(e) => { const v = parseInt(e.currentTarget.value); settingsStore.setPoolSettings({ otherSatisfied: isNaN(v) ? 5 : v }); }}
              class="input text-sm"
            />
          </label>
        </div>
      </div>
    </div>
    <button onclick={() => settingsStore.resetPoolSettings()} class="btn-ghost mt-2 text-xs text-text-3">
      Reset to defaults
    </button>

    <!-- Header Display Settings -->
    <div class="bg-surface-2 rounded divide-y divide-surface-3 mt-3">
      <label class="p-3 flex items-center justify-between cursor-pointer">
        <div>
          <span class="text-sm text-text-1">Show connectivity</span>
          <p class="text-xs text-text-3">Display connection status in header</p>
        </div>
        <input
          type="checkbox"
          checked={poolSettings.showConnectivity ?? true}
          onchange={(e) => settingsStore.setPoolSettings({ showConnectivity: e.currentTarget.checked })}
          class="w-4 h-4 accent-accent"
        />
      </label>
      <label class="p-3 flex items-center justify-between cursor-pointer">
        <div>
          <span class="text-sm text-text-1">Show bandwidth</span>
          <p class="text-xs text-text-3">Display upload/download rates in header</p>
        </div>
        <input
          type="checkbox"
          checked={poolSettings.showBandwidth ?? false}
          onchange={(e) => settingsStore.setPoolSettings({ showBandwidth: e.currentTarget.checked })}
          class="w-4 h-4 accent-accent"
        />
      </label>
    </div>
  </div>

  <!-- Peers -->
  <div>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
      Peers ({peerList.length})
    </h3>
    <p class="text-xs text-text-3 mb-3">WebRTC connections for file exchange</p>

    <!-- Transfer stats -->
    {#if isLoggedIn}
      <div class="bg-surface-2 rounded p-3 mb-3">
        <div class="grid grid-cols-3 gap-x-3 gap-y-2 text-xs mb-3">
          <div class="text-text-3 text-center">Session</div>
          <div class="text-center">
            <span class="text-success font-mono">{formatBytes(webrtcStats?.bytesSent ?? 0)}</span>
            <span class="text-text-3 ml-1">up</span>
          </div>
          <div class="text-center">
            <span class="text-accent font-mono">{formatBytes(webrtcStats?.bytesReceived ?? 0)}</span>
            <span class="text-text-3 ml-1">down</span>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-x-3 gap-y-2 text-xs">
          <div class="text-text-3 text-center">Lifetime</div>
          <div class="text-center">
            <span class="text-success font-mono">{formatBytes(lifetimeStats.bytesSent)}</span>
            <span class="text-text-3 ml-1">up</span>
          </div>
          <div class="text-center">
            <span class="text-accent font-mono">{formatBytes(lifetimeStats.bytesReceived)}</span>
            <span class="text-text-3 ml-1">down</span>
          </div>
        </div>
      </div>
    {/if}

    {#if !isLoggedIn}
      <div class="bg-surface-2 rounded p-3 text-sm text-muted">
        Login to connect with peers
      </div>
    {:else if peerList.length === 0}
      <div class="bg-surface-2 rounded p-3 text-sm text-muted">
        No peers connected
      </div>
    {:else}
      <div class="bg-surface-2 rounded divide-y divide-surface-3">
        {#each peerList as peer (peer.peerId)}
          {@const peerStats = getPeerStats(peer.peerId)}
          <div class="flex flex-col p-3 hover:bg-surface-3 transition-colors">
            <div class="flex items-center gap-2 text-sm">
              <span
                class="w-2 h-2 rounded-full shrink-0"
                style="background: {stateColor(peer.state)}"
              ></span>
              <a
                href="#/{nip19.npubEncode(peer.pubkey)}"
                class="flex-1 min-w-0 no-underline"
              >
                <UserRow
                  pubkey={peer.pubkey}
                  description={`${peer.state}${peer.pool === 'follows' ? ' (follow)' : ''}`}
                  avatarSize={32}
                  showBadge
                  class="flex-1 min-w-0"
                />
              </a>
              <span class="text-xs text-muted font-mono shrink-0">
                {getPeerUuid(peer.peerId).slice(0, 8)}
              </span>
              <button
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (confirm('Block this peer?')) {
                    blockPeer(peer.pubkey);
                  }
                }}
                class="btn-ghost p-1 text-text-3 hover:text-danger shrink-0"
                title="Block peer"
              >
                <span class="i-lucide-ban text-sm"></span>
              </button>
            </div>
            {#if peerStats && peer.state === 'connected'}
              <div class="mt-2 ml-4 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-3">
                <span title="Bytes sent" class="text-success">
                  <span class="i-lucide-arrow-up inline-block align-middle mr-0.5"></span>{formatBytes(peerStats.bytesSent)}
                </span>
                <span title="Bytes received" class="text-accent">
                  <span class="i-lucide-arrow-down inline-block align-middle mr-0.5"></span>{formatBytes(peerStats.bytesReceived)}
                </span>
              </div>
              <div class="mt-1 ml-4 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-text-3 font-mono">
                <span title="Hash queries sent to this peer">sent q: {peerStats.requestsSent}</span>
                <span title="Hash queries received from this peer">recv q: {peerStats.requestsReceived}</span>
                <span title="Responses sent to this peer">sent r: {peerStats.responsesSent}</span>
                <span title="Responses received from this peer">recv r: {peerStats.responsesReceived}</span>
                <span title="Requests from this peer that we forwarded upstream">fwd: {peerStats.forwardedRequests}</span>
                <span title="Forwarded requests from this peer later resolved">fwd ok: {peerStats.forwardedResolved}</span>
                <span class="col-span-2" title="Duplicate forwarded requests suppressed while hash was already in-flight">
                  fwd dup-suppressed: {peerStats.forwardedSuppressed}
                </span>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <!-- Blocked Peers -->
    {#if blockedPeers.length > 0}
      <div class="mt-4">
        <h4 class="text-xs font-medium text-muted uppercase tracking-wide mb-2">
          Blocked ({blockedPeers.length})
        </h4>
        <div class="bg-surface-2 rounded divide-y divide-surface-3">
          {#each blockedPeers as pubkey (pubkey)}
            <div class="flex items-center gap-2 p-2">
              <a
                href="#/{nip19.npubEncode(pubkey)}"
                class="flex-1 min-w-0 no-underline"
              >
                <UserRow
                  {pubkey}
                  description="Blocked"
                  avatarSize={28}
                  showBadge
                  class="flex-1 min-w-0"
                />
              </a>
              <button
                onclick={() => unblockPeer(pubkey)}
                class="btn-ghost p-1 text-text-3 hover:text-success shrink-0"
                title="Unblock peer"
              >
                <span class="i-lucide-check text-sm"></span>
              </button>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>
