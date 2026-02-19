<script lang="ts">
  import { p2pStore } from '../lib/p2p';

  let p2p = $derived($p2pStore);
  let rates = $state({ up: 0, down: 0 });
  let previous: { sent: number; received: number; at: number } | null = null;

  $effect(() => {
    const now = Date.now();
    const webrtcSent = p2p.peers.reduce((sum, peer) => sum + peer.bytesSent, 0);
    const webrtcReceived = p2p.peers.reduce((sum, peer) => sum + peer.bytesReceived, 0);
    const totalSent = webrtcSent + p2p.blossomBandwidth.totalBytesSent;
    const totalReceived = webrtcReceived + p2p.blossomBandwidth.totalBytesReceived;

    if (previous) {
      const elapsed = (now - previous.at) / 1000;
      if (elapsed > 0) {
        rates = {
          up: Math.max(0, (totalSent - previous.sent) / elapsed),
          down: Math.max(0, (totalReceived - previous.received) / elapsed),
        };
      }
    }

    previous = {
      sent: totalSent,
      received: totalReceived,
      at: now,
    };
  });

  function formatRate(bytesPerSecond: number): string {
    if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} kB/s`;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
</script>

<a
  href="/#/settings"
  class="flex flex-col items-end text-[11px] no-underline font-mono leading-tight whitespace-nowrap min-w-20"
  title={`Upload: ${formatRate(rates.up)}, Download: ${formatRate(rates.down)}`}
  data-testid="bandwidth-indicator"
>
  <span class="text-text-3">
    ↑ {formatRate(rates.up)}
  </span>
  <span class="text-text-3">
    ↓ {formatRate(rates.down)}
  </span>
</a>
