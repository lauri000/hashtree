<script lang="ts">
  import { uploadProgressStore } from '../lib/workerClient';

  const progress = $derived($uploadProgressStore);
  const percent = $derived.by(() => {
    if (!progress) return 0;
    if (progress.totalServers <= 0) return 0;
    return Math.round((progress.processedServers / progress.totalServers) * 100);
  });

  const statusText = $derived.by(() => {
    if (!progress) return '';
    if (!progress.complete) return `Uploading to Blossom (${percent}%)`;
    if (progress.failedServers > 0 && progress.uploadedServers === 0) return 'Upload failed on all servers';
    if (progress.failedServers > 0) return 'Uploaded with partial failures';
    if (progress.uploadedServers > 0) return 'Upload complete';
    return 'Already available on Blossom';
  });
</script>

{#if progress}
  <aside
    class="fixed right-4 bottom-4 z-40 w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border border-surface-3 bg-surface-1/95 backdrop-blur px-4 py-3 shadow-lg"
    data-testid="upload-progress-toast"
  >
    <div class="flex items-center justify-between gap-3 mb-2">
      <div class="text-sm font-medium text-text-1 truncate">{statusText}</div>
      <div class="text-xs text-text-3 font-mono">{progress.processedServers}/{progress.totalServers}</div>
    </div>

    <div class="h-1.5 rounded-full bg-surface-3 overflow-hidden">
      <div
        class="h-full transition-all duration-200 {progress.complete && progress.failedServers > 0 ? 'bg-yellow-500' : 'bg-accent'}"
        style={`width:${percent}%`}
      ></div>
    </div>

    <div class="mt-2 flex items-center gap-3 text-xs text-text-3">
      <span>Uploaded: {progress.uploadedServers}</span>
      <span>Skipped: {progress.skippedServers}</span>
      <span class={progress.failedServers > 0 ? 'text-danger' : ''}>Failed: {progress.failedServers}</span>
    </div>
  </aside>
{/if}
