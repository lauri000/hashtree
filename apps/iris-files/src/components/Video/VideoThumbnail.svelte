<script lang="ts">
  /**
   * VideoThumbnail - Reusable video thumbnail with duration and progress bar
   * Used by VideoCard, FeedSidebar, PlaylistSidebar, etc.
   */
  import { onDestroy } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { formatDuration } from '../../utils/format';
  import { shouldEagerLoadMediaInNativeChildRuntime } from '../../lib/nativeHtree';
  import {
    appendMediaImageRetryParam,
    getMediaImageRetryDelayMs,
    isRetryableMediaImageUrl,
    MAX_MEDIA_IMAGE_RETRIES,
  } from '../../lib/mediaImageRetry';
  import { isAudioMediaFileName } from '../../lib/playableMedia';

  const IMAGE_CANDIDATE_STALL_TIMEOUT_MS = 8000;
  const VIDEO_FALLBACK_LOAD_TIMEOUT_MS = 2500;

  interface Props {
    /** Thumbnail URL */
    src?: string | null;
    /** Additional image URLs to try when the primary thumbnail fails */
    fallbackImageUrls?: string[] | null;
    /** Exact in-tree fallback video URLs to use when no image thumbnail is available */
    fallbackVideoUrls?: string[] | null;
    /** Legacy placeholder metadata kept for component prop compatibility */
    fallbackTitle?: string | null;
    /** Legacy placeholder metadata kept for component prop compatibility */
    fallbackSubtitle?: string | null;
    /** Legacy placeholder metadata kept for component prop compatibility */
    fallbackSeed?: string | null;
    /** Milliseconds to wait before advancing from a stalled image candidate */
    imageCandidateStallTimeoutMs?: number;
    /** Video duration in seconds */
    duration?: number;
    /** Watch progress percentage (0-100) */
    progress?: number;
    /** Additional classes for the container */
    class?: string;
    /** Legacy placeholder sizing prop kept for compatibility */
    iconSize?: string;
  }

  let {
    src,
    fallbackImageUrls = null,
    fallbackVideoUrls = null,
    imageCandidateStallTimeoutMs = IMAGE_CANDIDATE_STALL_TIMEOUT_MS,
    duration,
    progress = 0,
    class: className = ''
  }: Props = $props();

  let imageError = $state(false);
  let imageLoaded = $state(false);
  let lastMediaKey = $state('');
  let retryCount = $state(0);
  let imageCandidateIndex = $state(0);
  let renderedSrc = $state<string | null>(null);
  let videoCandidateIndex = $state(0);
  let videoFailed = $state(false);
  let fallbackVisible = $state(typeof IntersectionObserver === 'undefined');
  let capturedVideoFrameUrl = $state<string | null>(null);
  let containerEl = $state<HTMLDivElement | null>(null);
  let imageEl = $state<HTMLImageElement | null>(null);
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let imageLoadTimer: ReturnType<typeof setTimeout> | null = null;
  let videoLoadTimer: ReturnType<typeof setTimeout> | null = null;
  let capturedFrameObjectUrl: string | null = null;
  const loadingStrategy = shouldEagerLoadMediaInNativeChildRuntime() ? 'eager' : 'lazy';

  function canUseVideoFrameFallback(url: string): boolean {
    try {
      const parsed = new URL(url, window.location.href);
      const fileName = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
      return !isAudioMediaFileName(fileName);
    } catch {
      const fileName = url.split('?')[0]?.split('/').filter(Boolean).at(-1) ?? '';
      return !isAudioMediaFileName(fileName);
    }
  }
  const resolvedImageCandidateUrls = $derived.by(() => {
    const urls = new SvelteSet<string>();
    if (src) {
      urls.add(src);
    }
    for (const url of fallbackImageUrls ?? []) {
      if (url) {
        urls.add(url);
      }
    }
    return Array.from(urls);
  });
  const resolvedFallbackVideoUrls = $derived.by(() =>
    (fallbackVideoUrls ?? []).filter((url): url is string => !!url && canUseVideoFrameFallback(url))
  );
  const activeFallbackVideoUrl = $derived.by(() =>
    fallbackVisible && !capturedVideoFrameUrl
      ? resolvedFallbackVideoUrls[videoCandidateIndex] ?? null
      : null
  );

  // Reset state when the image or fallback candidates change.
  $effect.pre(() => {
    const nextMediaKey = `${resolvedImageCandidateUrls.join('|')}::${resolvedFallbackVideoUrls.join('|')}`;
    if (nextMediaKey !== lastMediaKey) {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      clearImageLoadTimer();
      clearVideoLoadTimer();
      imageError = false;
      imageLoaded = false;
      retryCount = 0;
      imageCandidateIndex = 0;
      renderedSrc = resolvedImageCandidateUrls[0] ?? null;
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
    clearImageLoadTimer();
    clearVideoLoadTimer();
    clearCapturedVideoFrame();
  });

  function clearImageLoadTimer(): void {
    if (imageLoadTimer) {
      clearTimeout(imageLoadTimer);
      imageLoadTimer = null;
    }
  }

  function clearVideoLoadTimer(): void {
    if (videoLoadTimer) {
      clearTimeout(videoLoadTimer);
      videoLoadTimer = null;
    }
  }

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

  function advanceImageCandidateOrFail(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    clearImageLoadTimer();
    if (imageCandidateIndex + 1 < resolvedImageCandidateUrls.length) {
      const nextIndex = imageCandidateIndex + 1;
      imageCandidateIndex = nextIndex;
      retryCount = 0;
      imageError = false;
      imageLoaded = false;
      renderedSrc = resolvedImageCandidateUrls[nextIndex] ?? null;
      return;
    }
    imageError = true;
    imageLoaded = false;
  }

  function advanceVideoCandidateOrFail(): void {
    clearVideoLoadTimer();
    stopVideo(containerEl?.querySelector('video') ?? null);
    if (videoCandidateIndex + 1 < resolvedFallbackVideoUrls.length) {
      videoCandidateIndex += 1;
      return;
    }
    videoFailed = true;
  }

  $effect(() => {
    if (!renderedSrc || imageError || capturedVideoFrameUrl) {
      clearImageLoadTimer();
      return;
    }

    const candidate = renderedSrc;
    clearImageLoadTimer();
    imageLoadTimer = setTimeout(() => {
      if (renderedSrc !== candidate || imageError || capturedVideoFrameUrl) return;
      advanceImageCandidateOrFail();
    }, imageCandidateStallTimeoutMs);

    return () => {
      clearImageLoadTimer();
    };
  });

  $effect(() => {
    if (!activeFallbackVideoUrl || videoFailed || capturedVideoFrameUrl) {
      clearVideoLoadTimer();
      return;
    }

    clearVideoLoadTimer();
    const candidate = activeFallbackVideoUrl;
    videoLoadTimer = setTimeout(() => {
      if (activeFallbackVideoUrl !== candidate || videoFailed || capturedVideoFrameUrl) return;
      advanceVideoCandidateOrFail();
    }, VIDEO_FALLBACK_LOAD_TIMEOUT_MS);

    return () => {
      clearVideoLoadTimer();
    };
  });

  $effect(() => {
    const image = imageEl;
    if (!image || !renderedSrc || imageError || capturedVideoFrameUrl) {
      return;
    }
    if (image.complete && image.naturalWidth > 0) {
      handleImageLoad();
    }
  });

  function handleImageLoad(): void {
    clearImageLoadTimer();
    imageLoaded = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function handleImageError(event: Event): void {
    clearImageLoadTimer();
    imageLoaded = false;
    const image = event.currentTarget as HTMLImageElement | null;
    const baseSrc = resolvedImageCandidateUrls[imageCandidateIndex] ?? renderedSrc ?? null;
    if (!baseSrc || !isRetryableMediaImageUrl(baseSrc) || retryCount >= MAX_MEDIA_IMAGE_RETRIES) {
      advanceImageCandidateOrFail();
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
      imageLoaded = false;
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

    clearVideoLoadTimer();
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
    advanceVideoCandidateOrFail();
  }
</script>

<div bind:this={containerEl} class="relative bg-media-placeholder overflow-hidden {className}">
  {#if renderedSrc && !imageError}
    <img
      bind:this={imageEl}
      src={renderedSrc}
      alt=""
      class="absolute inset-0 w-full h-full object-cover"
      class:opacity-0={!imageLoaded}
      loading={loadingStrategy}
      onload={handleImageLoad}
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

  {#if (!renderedSrc || imageError || !imageLoaded) && !capturedVideoFrameUrl}
    <div data-testid="media-placeholder" class="absolute inset-0 bg-media-placeholder"></div>
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
