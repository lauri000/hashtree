<script lang="ts">
  import { uploadProgressStore } from '../lib/workerClient';
  import { localSaveProgressStore } from '../lib/localSaveProgress';

  const blossomProgress = $derived($uploadProgressStore);
  const localSaveProgress = $derived($localSaveProgressStore);
  const showLocalSaveToast = $derived(!!localSaveProgress && !blossomProgress);

  function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function formatMb(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    if (!Number.isFinite(mb) || mb <= 0) return '0.0';
    return mb >= 100 ? mb.toFixed(0) : mb.toFixed(1);
  }

  function serverLabel(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url.replace(/^https?:\/\//, '');
    }
  }

  type ServerState = 'pending' | 'uploading' | 'uploaded' | 'skipped' | 'failed' | 'partial';

  function resolveServerState(
    server: { uploaded: number; skipped: number; failed: number },
    complete: boolean
  ): ServerState {
    if (complete) {
      if (server.failed > 0 && (server.uploaded > 0 || server.skipped > 0)) return 'partial';
      if (server.failed > 0) return 'failed';
      if (server.uploaded > 0) return 'uploaded';
      if (server.skipped > 0) return 'skipped';
      return 'pending';
    }
    if (server.failed > 0 && server.uploaded === 0 && server.skipped === 0) return 'failed';
    if (server.uploaded > 0 || server.skipped > 0 || server.failed > 0) return 'uploading';
    return 'pending';
  }

  function serverStateText(state: ServerState): string {
    if (state === 'uploading') return 'uploading';
    if (state === 'uploaded') return 'uploaded';
    if (state === 'skipped') return 'skipped';
    if (state === 'failed') return 'failed';
    if (state === 'partial') return 'partial';
    return 'pending';
  }

  function serverStateClass(state: ServerState): string {
    if (state === 'uploaded') return 'text-success';
    if (state === 'failed' || state === 'partial') return 'text-danger';
    if (state === 'skipped') return 'text-text-3';
    if (state === 'uploading') return 'text-accent';
    return 'text-text-3';
  }

  const percent = $derived.by(() => {
    if (!blossomProgress) return 0;
    if (typeof blossomProgress.progressRatio === 'number') {
      return clampPercent(blossomProgress.progressRatio * 100);
    }
    if (typeof blossomProgress.totalChunks === 'number'
      && blossomProgress.totalChunks > 0
      && typeof blossomProgress.processedChunks === 'number') {
      return clampPercent((blossomProgress.processedChunks / blossomProgress.totalChunks) * 100);
    }
    if (blossomProgress.totalServers <= 0) return 0;
    return clampPercent((blossomProgress.processedServers / blossomProgress.totalServers) * 100);
  });
  const blossomDetailText = $derived.by(() => {
    if (!blossomProgress) return '';
    if (typeof blossomProgress.totalChunks === 'number'
      && blossomProgress.totalChunks > 0
      && typeof blossomProgress.processedChunks === 'number') {
      return `${blossomProgress.processedChunks}/${blossomProgress.totalChunks} chunks`;
    }
    return `${blossomProgress.processedServers}/${blossomProgress.totalServers} servers`;
  });
  const localPercent = $derived.by(() => {
    if (!localSaveProgress) return 0;
    if (localSaveProgress.totalBytes <= 0) return 0;
    const raw = Math.min(100, Math.round((localSaveProgress.bytesSaved / localSaveProgress.totalBytes) * 100));
    // finalizing can take a while; avoid showing "done" before finalize really returns.
    if (localSaveProgress.phase === 'finalizing' && raw >= 100) {
      return 99;
    }
    return raw;
  });

  const localStatusText = $derived.by(() => {
    if (!localSaveProgress) return '';
    if (localSaveProgress.phase === 'finalizing') return 'finalizing...';
    if (localSaveProgress.phase === 'reading') return 'reading...';
    return 'writing...';
  });

  const localDetailText = $derived.by(() => {
    if (!localSaveProgress) return 'IndexedDB';
    const doneMb = formatMb(localSaveProgress.bytesSaved);
    const totalMb = formatMb(localSaveProgress.totalBytes);
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

  const serverRows = $derived.by(() => {
    if (!blossomProgress?.serverStatuses?.length) return [];
    return blossomProgress.serverStatuses.map((server) => {
      const state = resolveServerState(server, blossomProgress.complete);
      return {
        key: server.url,
        label: serverLabel(server.url),
        stateText: serverStateText(state),
        stateClass: serverStateClass(state),
      };
    });
  });
</script>

{#if blossomProgress}
  <aside
    class="fixed right-4 bottom-4 z-40 w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border border-surface-3 bg-surface-1/95 backdrop-blur px-4 py-3 shadow-lg"
    data-testid="upload-progress-toast"
  >
    <div class="flex items-center justify-between gap-3 mb-2">
      <div class="text-sm font-medium text-text-1 truncate">{statusText}</div>
      <div class="text-xs text-text-3 font-mono">{blossomDetailText}</div>
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

    {#if serverRows.length > 0}
      <div class="mt-2 border-t border-surface-3/80 pt-2 space-y-1">
        {#each serverRows as server (server.key)}
          <div class="flex items-center justify-between gap-3 text-xs">
            <span class="text-text-3 truncate">{server.label}</span>
            <span class={`font-mono ${server.stateClass}`}>{server.stateText}</span>
          </div>
        {/each}
      </div>
    {/if}
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
