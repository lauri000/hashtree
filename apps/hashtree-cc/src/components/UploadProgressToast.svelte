<script lang="ts">
  import { uploadProgressStore } from '../lib/workerClient';
  import { localSaveProgressStore } from '../lib/localSaveProgress';

  const blossomProgress = $derived($uploadProgressStore);
  const localSaveProgress = $derived($localSaveProgressStore);
  const showLocalSaveToast = $derived(!!localSaveProgress && !blossomProgress);
  const percent = $derived.by(() => {
    if (!blossomProgress) return 0;
    if (blossomProgress.totalServers <= 0) return 0;
    return Math.round((blossomProgress.processedServers / blossomProgress.totalServers) * 100);
  });
  const localPercent = $derived.by(() => {
    if (!localSaveProgress) return 0;
    if (localSaveProgress.totalBytes <= 0) return 0;
    return Math.min(100, Math.round((localSaveProgress.bytesSaved / localSaveProgress.totalBytes) * 100));
  });

  const localStatusText = $derived.by(() => {
    if (!localSaveProgress) return '';
    if (localSaveProgress.phase === 'finalizing') return 'finalizing...';
    if (localSaveProgress.phase === 'reading') return 'reading...';
    return 'writing...';
  });

  const localDetailText = $derived.by(() => {
    if (!localSaveProgress) return 'IndexedDB';
    const doneMb = Math.round(localSaveProgress.bytesSaved / 1024 / 1024);
    const totalMb = Math.max(1, Math.round(localSaveProgress.totalBytes / 1024 / 1024));
    return `${doneMb}MB / ${totalMb}MB`;
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
    <div class="flex items-center gap-2 mb-2">
      <span class="i-lucide-loader-2 animate-spin text-accent shrink-0"></span>
      <span class="text-sm text-text-1 truncate flex-1">{localSaveProgress?.fileName || 'upload'}</span>
    </div>
    <div class="h-1.5 rounded-full bg-surface-3 overflow-hidden">
      <div class="h-full bg-accent transition-all duration-150" style={`width:${Math.max(2, localPercent)}%`}></div>
    </div>
    <div class="mt-2 flex items-center justify-between text-xs text-text-3">
      <span class="capitalize">{localStatusText}</span>
      <span>{localPercent}%</span>
    </div>
    <div class="text-xs text-text-3">{localDetailText}</div>
  </aside>
{/if}
