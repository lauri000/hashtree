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
    /** Exact in-tree fallback video URLs to use when no image thumbnail is available */
    fallbackVideoUrls?: string[] | null;
    /** Video duration in seconds */
    duration?: number;
    /** Watch progress percentage (0-100) */
    progress?: number;
    /** Additional classes for the container */
    class?: string;
    /** Size of fallback icon (default: text-4xl) */
    iconSize?: string;
  }

  let {
    src,
    fallbackVideoUrls = null,
    duration,
    progress = 0,
    class: className = '',
    iconSize = 'text-4xl'
  }: Props = $props();

  let imageError = $state(false);
  let lastMediaKey = $state('');
  let retryCount = $state(0);
  let renderedSrc = $state<string | null>(null);
  let videoCandidateIndex = $state(0);
  let videoReady = $state(false);
  let videoFailed = $state(false);
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const loadingStrategy = shouldEagerLoadMediaInNativeChildRuntime() ? 'eager' : 'lazy';
  const resolvedFallbackVideoUrls = $derived.by(() => (fallbackVideoUrls ?? []).filter(Boolean));
  const activeFallbackVideoUrl = $derived.by(() => resolvedFallbackVideoUrls[videoCandidateIndex] ?? null);

  // Reset state when the image or fallback candidates change.
  $effect.pre(() => {
    const nextMediaKey = `${src ?? ''}::${resolvedFallbackVideoUrls.join('|')}`;
    if (nextMediaKey !== lastMediaKey) {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      imageError = false;
      retryCount = 0;
      renderedSrc = src ?? null;
      videoCandidateIndex = 0;
      videoReady = false;
      videoFailed = false;
      lastMediaKey = nextMediaKey;
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

  function handleVideoLoadedMetadata(event: Event): void {
    const video = event.currentTarget as HTMLVideoElement | null;
    if (!video) return;
    if (video.currentTime > 0 || !Number.isFinite(video.duration) || video.duration <= 0) return;
    try {
      video.currentTime = Math.min(0.05, video.duration / 10);
    } catch {
      // Some browsers disallow immediate seeking here; loadeddata still reveals frame 0.
    }
  }

  function handleVideoLoadedData(): void {
    videoReady = true;
    videoFailed = false;
  }

  function handleVideoError(): void {
    videoReady = false;
    if (videoCandidateIndex + 1 < resolvedFallbackVideoUrls.length) {
      videoCandidateIndex += 1;
      return;
    }
    videoFailed = true;
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
  {:else if activeFallbackVideoUrl && !videoFailed}
    <video
      src={activeFallbackVideoUrl}
      muted
      playsinline
      preload="metadata"
      class="absolute inset-0 w-full h-full object-cover {videoReady ? '' : 'opacity-0'}"
      onloadedmetadata={handleVideoLoadedMetadata}
      onloadeddata={handleVideoLoadedData}
      onerror={handleVideoError}
    ></video>
  {/if}

  {#if (!renderedSrc || imageError) && (!activeFallbackVideoUrl || videoFailed || !videoReady)}
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
