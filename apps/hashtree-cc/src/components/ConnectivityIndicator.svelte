<script lang="ts">
  import { connectivityStore } from '../lib/workerClient';
  import { p2pStore } from '../lib/p2p';

  let connectivity = $derived($connectivityStore);
  let p2p = $derived($p2pStore);
  let peerCount = $derived(p2p.peerCount);
  let configuredRelays = $derived(p2p.relayCount);
  let connectedRelays = $derived(p2p.connectedRelayCount);
  let displayRelays = $derived.by(() => connectedRelays > 0 ? connectedRelays : configuredRelays);
  let totalConnections = $derived(displayRelays + peerCount);

  let color = $derived.by(() => {
    if (!connectivity.online) return '#ff5f56';
    if (connectedRelays === 0) return configuredRelays > 0 ? '#f4bf4f' : '#ff5f56';
    if (peerCount === 0) return '#f4bf4f';
    return '#2ba640';
  });

  let title = $derived.by(() => {
    if (!connectivity.online) return 'Offline';
    if (connectedRelays === 0) {
      return configuredRelays > 0
        ? `Connecting to ${configuredRelays} relay${configuredRelays !== 1 ? 's' : ''}`
        : 'No relays configured';
    }
    if (peerCount === 0) return `${connectedRelays} relay${connectedRelays !== 1 ? 's' : ''}, no peers`;
    return `${peerCount} peer${peerCount !== 1 ? 's' : ''}, ${connectedRelays} relay${connectedRelays !== 1 ? 's' : ''}`;
  });
</script>

<a
  href="/#/settings"
  class="flex flex-col items-center px-2 py-1 no-underline text-sm"
  title={title}
  data-testid="connectivity-indicator"
>
  <span class="i-lucide-wifi" style="color: {color}"></span>
  <span class="text-xs -mt-1" style="color: {color}">{totalConnections}</span>
</a>
