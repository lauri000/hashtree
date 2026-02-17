<script lang="ts">
  import { connectivityStore } from '../lib/workerClient';
  import { p2pStore } from '../lib/p2p';

  let connectivity = $derived($connectivityStore);
  let p2p = $derived($p2pStore);
  let totalServers = $derived(connectivity.totalReadServers > 0 ? connectivity.totalReadServers : connectivity.totalWriteServers);
  let reachableServers = $derived(connectivity.totalReadServers > 0 ? connectivity.reachableReadServers : connectivity.reachableWriteServers);
  let peerCount = $derived(p2p.peerCount);

  let color = $derived.by(() => {
    if (!connectivity.online) return '#ff5f56';
    if (peerCount > 0) return '#2ba640';
    if (totalServers === 0) return '#6a6a6a';
    if (reachableServers === 0) return '#ff5f56';
    if (reachableServers < totalServers) return '#f4bf4f';
    return '#2ba640';
  });

  let title = $derived.by(() => {
    if (!connectivity.online) return 'Offline';
    if (totalServers === 0) return `${peerCount} peers, no servers configured`;
    return `${peerCount} peers, ${reachableServers}/${totalServers} servers reachable`;
  });
</script>

<a
  href="/#/settings"
  class="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface-1/70 no-underline text-xs"
  title={title}
  data-testid="connectivity-indicator"
>
  <span class="i-lucide-wifi text-sm" style="color: {color}"></span>
  <span style="color: {color}">{peerCount}p {reachableServers}/{totalServers}s</span>
</a>
