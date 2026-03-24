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
  let videoFailed = $state(false);
  let fallbackVisible = $state(typeof IntersectionObserver === 'undefined');
  let capturedVideoFrameUrl = $state<string | null>(null);
  let containerEl = $state<HTMLDivElement | null>(null);
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let capturedFrameObjectUrl: string | null = null;
  const loadingStrategy = shouldEagerLoadMediaInNativeChildRuntime() ? 'eager' : 'lazy';
  const resolvedFallbackVideoUrls = $derived.by(() => (fallbackVideoUrls ?? []).filter(Boolean));
  const activeFallbackVideoUrl = $derived.by(() =>
    fallbackVisible && !capturedVideoFrameUrl
      ? resolvedFallbackVideoUrls[videoCandidateIndex] ?? null
      : null
  );

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
      videoFailed = false;
      clearCapturedVideoFrame();
      lastMediaKey = nextMediaKey;
    }
  });

  $effect(() => {
    const node = containerEl;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      fallbackVisible = true;
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        fallbackVisible = !!entry && (entry.isIntersecting || entry.intersectionRatio > 0);
      },
      { rootMargin: '200px' }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  });

  onDestroy(() => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    clearCapturedVideoFrame();
  });

  function clearCapturedVideoFrame(): void {
    if (capturedFrameObjectUrl) {
      URL.revokeObjectURL(capturedFrameObjectUrl);
      capturedFrameObjectUrl = null;
    }
    capturedVideoFrameUrl = null;
  }

  function stopVideo(video: HTMLVideoElement | null): void {
    if (!video) return;
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      // Ignore teardown failures on detached media elements.
    }
  }

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

  async function captureVideoFrame(video: HTMLVideoElement): Promise<string | null> {
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;

    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), 'image/webp', 0.8);
    });

    if (!blob) return null;
    return URL.createObjectURL(blob);
  }

  async function handleVideoLoadedData(event: Event): Promise<void> {
    const video = event.currentTarget as HTMLVideoElement | null;
    if (!video) return;

    const frameUrl = await captureVideoFrame(video);
    stopVideo(video);

    if (!frameUrl) {
      videoFailed = true;
      return;
    }

    clearCapturedVideoFrame();
    capturedFrameObjectUrl = frameUrl;
    capturedVideoFrameUrl = frameUrl;
    videoFailed = false;
  }

  function handleVideoError(event: Event): void {
    stopVideo(event.currentTarget as HTMLVideoElement | null);
    if (videoCandidateIndex + 1 < resolvedFallbackVideoUrls.length) {
      videoCandidateIndex += 1;
      return;
    }
    videoFailed = true;
  }
</script>

<div bind:this={containerEl} class="relative bg-surface-2 overflow-hidden {className}">
  {#if renderedSrc && !imageError}
    <img
      src={renderedSrc}
      alt=""
      class="absolute inset-0 w-full h-full object-cover"
      loading={loadingStrategy}
      onerror={handleImageError}
    />
  {:else if capturedVideoFrameUrl}
    <img
      src={capturedVideoFrameUrl}
      alt=""
      class="absolute inset-0 w-full h-full object-cover"
      loading={loadingStrategy}
    />
  {:else if activeFallbackVideoUrl && !videoFailed}
    <video
      src={activeFallbackVideoUrl}
      muted
      playsinline
      preload="metadata"
      class="absolute inset-0 w-full h-full object-cover opacity-0 pointer-events-none"
      onloadeddata={handleVideoLoadedData}
      onerror={handleVideoError}
    ></video>
  {/if}

  {#if (!renderedSrc || imageError) && !capturedVideoFrameUrl && (!activeFallbackVideoUrl || videoFailed)}
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
