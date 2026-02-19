<script lang="ts">
  import { uploadHistoryStore, type UploadEntry } from '../lib/uploadHistory';

  const entries = $derived(uploadHistoryStore);

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function relativeTime(ts: number): string {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }
</script>

{#if $entries.length > 0}
  <section class="mt-6" data-testid="upload-history">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-text-1 text-sm font-medium">Recent uploads</h3>
      <button
        class="text-text-3 text-xs hover:text-text-1 transition-colors"
        onclick={() => uploadHistoryStore.clear()}
        data-testid="upload-history-clear"
      >
        Clear all
      </button>
    </div>
    <div class="bg-surface-1 rounded-xl border border-surface-3 divide-y divide-surface-3">
      {#each $entries as entry (entry.nhash)}
        <div class="flex items-center gap-3 px-4 py-2.5 group" data-testid="upload-history-entry">
          <a
            href="/#/{entry.nhash}/{encodeURIComponent(entry.fileName)}"
            class="text-accent text-sm truncate min-w-0 flex-1 hover:underline"
            data-testid="upload-history-link"
          >
            {entry.fileName}
          </a>
          <span class="text-text-3 text-xs shrink-0">{formatSize(entry.size)}</span>
          <span class="text-text-3 text-xs shrink-0">{relativeTime(entry.uploadedAt)}</span>
          <button
            class="text-text-3 hover:text-text-1 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
            onclick={() => uploadHistoryStore.remove(entry.nhash)}
            aria-label="Remove"
            data-testid="upload-history-remove"
          >
            <span class="i-lucide-x text-xs"></span>
          </button>
        </div>
      {/each}
    </div>
  </section>
{/if}
