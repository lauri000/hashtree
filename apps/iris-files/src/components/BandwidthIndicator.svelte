<script lang="ts">
  /**
   * Bandwidth indicator - shows current upload/download rates in header
   */
  import { getBandwidthUsageTotals } from '../store';

  // Track previous bytes for rate calculation
  let prevBytes = $state({ sent: 0, received: 0, time: Date.now() });
  let rates = $state({ up: 0, down: 0 });

  // Update rates periodically
  $effect(() => {
    const interval = setInterval(() => {
      const totals = getBandwidthUsageTotals();
      const now = Date.now();
      const elapsed = (now - prevBytes.time) / 1000; // seconds

      if (elapsed > 0 && prevBytes.time > 0) {
        const sentDiff = totals.totalBytesSent - prevBytes.sent;
        const receivedDiff = totals.totalBytesReceived - prevBytes.received;

        rates = {
          up: Math.max(0, sentDiff / elapsed),
          down: Math.max(0, receivedDiff / elapsed),
        };
      }

      prevBytes = {
        sent: totals.totalBytesSent,
        received: totals.totalBytesReceived,
        time: now,
      };
    }, 1000);

    return () => clearInterval(interval);
  });

  function formatRate(bytesPerSec: number): string {
    if (bytesPerSec < 1024) return `${Math.round(bytesPerSec).toString().padStart(4)} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1).padStart(4)} kB/s`;
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1).padStart(4)} MB/s`;
  }
</script>

<a
  href="#/settings/p2p"
  class="flex flex-col items-end text-xs no-underline font-mono leading-tight w-24 whitespace-nowrap"
  title="Upload: {formatRate(rates.up)}, Download: {formatRate(rates.down)}"
>
  <span class="flex items-center gap-0.5" class:text-green-400={rates.up > 0} class:text-text-3={rates.up === 0}>
    <span>{formatRate(rates.up)}</span>
    <span class="i-lucide-arrow-up text-xs"></span>
  </span>
  <span class="flex items-center gap-0.5" class:text-blue-400={rates.down > 0} class:text-text-3={rates.down === 0}>
    <span>{formatRate(rates.down)}</span>
    <span class="i-lucide-arrow-down text-xs"></span>
  </span>
</a>
