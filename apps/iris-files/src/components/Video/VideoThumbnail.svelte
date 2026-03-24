<script lang="ts">
  /**
   * VideoThumbnail - Reusable video thumbnail with duration and progress bar
   * Used by VideoCard, FeedSidebar, PlaylistSidebar, etc.
   */
  import { onDestroy } from 'svelte';
  import { formatDuration } from '../../utils/format';
  import { shouldEagerLoadMediaInNativeChildRuntime } from '../../lib/nativeHtree';
  import {
    appendMediaImageRetryParam,
    getMediaImageRetryDelayMs,
    isRetryableMediaImageUrl,
    MAX_MEDIA_IMAGE_RETRIES,
  } from '../../lib/mediaImageRetry';

  interface Props {
    /** Thumbnail URL */
    src?: string | null;
    /** Video duration in seconds */
    duration?: number;
    /** Watch progress percentage (0-100) */
    progress?: number;
    /** Additional classes for the container */
    class?: string;
    /** Size of fallback icon (default: text-4xl) */
    iconSize?: string;
  }

  let { src, duration, progress = 0, class: className = '', iconSize = 'text-4xl' }: Props = $props();

  let imageError = $state(false);
  let lastSrc = $state<string | null>(null);
  let retryCount = $state(0);
  let renderedSrc = $state<string | null>(null);
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const loadingStrategy = shouldEagerLoadMediaInNativeChildRuntime() ? 'eager' : 'lazy';

  // Reset error when src changes
  $effect.pre(() => {
    if (src !== lastSrc) {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      imageError = false;
      retryCount = 0;
      lastSrc = src ?? null;
      renderedSrc = src ?? null;
    }
  });

  onDestroy(() => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  });

  function handleImageError(event: Event): void {
    const image = event.currentTarget as HTMLImageElement | null;
    const baseSrc = src ?? null;
    if (!baseSrc || !isRetryableMediaImageUrl(baseSrc) || retryCount >= MAX_MEDIA_IMAGE_RETRIES) {
      imageError = true;
      return;
    }

    const nextRetry = retryCount + 1;
    retryCount = nextRetry;
    const retryUrl = appendMediaImageRetryParam(baseSrc, nextRetry);
    const delayMs = getMediaImageRetryDelayMs(nextRetry);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (image && !image.isConnected) return;
      imageError = false;
      renderedSrc = retryUrl;
    }, delayMs);
  }
</script>

<div class="relative bg-surface-2 overflow-hidden {className}">
  {#if renderedSrc && !imageError}
    <img
      src={renderedSrc}
      alt=""
      class="absolute inset-0 w-full h-full object-cover"
      loading={loadingStrategy}
      onerror={handleImageError}
    />
  {:else}
    <div class="absolute inset-0 flex items-center justify-center">
      <span class="i-lucide-video text-text-3 {iconSize}"></span>
    </div>
  {/if}

  <!-- Duration label - positioned above progress bar -->
  {#if duration}
    <div class="absolute bottom-2 right-1 bg-black/80 text-white text-[10px] px-1 rounded z-10">
      {formatDuration(duration)}
    </div>
  {/if}

  <!-- Watch progress bar -->
  {#if progress > 0}
    <div class="absolute bottom-0 left-0 right-0 h-1 bg-white/30">
      <div class="h-full bg-danger" style="width: {progress}%"></div>
    </div>
  {/if}
</div>
