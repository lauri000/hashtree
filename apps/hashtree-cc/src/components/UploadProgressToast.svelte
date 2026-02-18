<script lang="ts">
  import { uploadProgressStore } from '../lib/workerClient';
  import { localSaveInProgressStore } from '../lib/localSaveProgress';

  const blossomProgress = $derived($uploadProgressStore);
  const localSaveInProgress = $derived($localSaveInProgressStore);
  const showLocalSaveToast = $derived(localSaveInProgress && !blossomProgress);
  const percent = $derived.by(() => {
    if (!blossomProgress) return 0;
    if (blossomProgress.totalServers <= 0) return 0;
    return Math.round((blossomProgress.processedServers / blossomProgress.totalServers) * 100);
  });

  const statusText = $derived.by(() => {
    if (!blossomProgress) return '';
    if (!blossomProgress.complete) return `Uploading to Blossom (${percent}%)`;
    if (blossomProgress.failedServers > 0 && blossomProgress.uploadedServers === 0) return 'Upload failed on all servers';
    if (blossomProgress.failedServers > 0) return 'Uploaded with partial failures';
    if (blossomProgress.uploadedServers > 0) return 'Upload complete';
    return 'Already available on Blossom';
  });
</script>

{#if blossomProgress}
  <aside
    class="fixed right-4 bottom-4 z-40 w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border border-surface-3 bg-surface-1/95 backdrop-blur px-4 py-3 shadow-lg"
    data-testid="upload-progress-toast"
  >
    <div class="flex items-center justify-between gap-3 mb-2">
      <div class="text-sm font-medium text-text-1 truncate">{statusText}</div>
      <div class="text-xs text-text-3 font-mono">{blossomProgress.processedServers}/{blossomProgress.totalServers}</div>
    </div>

    <div class="h-1.5 rounded-full bg-surface-3 overflow-hidden">
      <div
        class="h-full transition-all duration-200 {blossomProgress.complete && blossomProgress.failedServers > 0 ? 'bg-yellow-500' : 'bg-accent'}"
        style={`width:${percent}%`}
      ></div>
    </div>

    <div class="mt-2 flex items-center gap-3 text-xs text-text-3">
      <span>Uploaded: {blossomProgress.uploadedServers}</span>
      <span>Skipped: {blossomProgress.skippedServers}</span>
      <span class={blossomProgress.failedServers > 0 ? 'text-danger' : ''}>Failed: {blossomProgress.failedServers}</span>
    </div>
  </aside>
{:else if showLocalSaveToast}
  <aside
    class="fixed right-4 bottom-4 z-40 w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border border-surface-3 bg-surface-1/95 backdrop-blur px-4 py-3 shadow-lg"
    data-testid="upload-progress-toast"
  >
    <div class="text-sm font-medium text-text-1">Saving to local storage...</div>
    <div class="mt-2 h-1.5 rounded-full bg-surface-3 overflow-hidden">
      <div class="h-full w-full bg-accent animate-pulse"></div>
    </div>
    <div class="mt-2 text-xs text-text-3">IndexedDB</div>
  </aside>
{/if}
