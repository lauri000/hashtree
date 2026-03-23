<script lang="ts">
  import { onMount } from 'svelte';
  import { getNpubFileUrl } from '../../lib/mediaUrl';

  declare global {
    interface Window {
      __HTREE_CANONICAL_URL__?: string | null;
    }
  }

  const enabled = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('smoke') === '1';

  let imageUrl = $state('');
  let videoUrl = $state('');
  let status = $state('Waiting for smoke assets');
  let imageReady = $state(false);
  let videoReady = $state(false);
  let imageError = $state('');
  let videoError = $state('');

  async function probeAsset(
    url: string,
    onReady: () => void,
    onError: (message: string) => void,
  ): Promise<void> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (!response.ok) {
        onError(`Smoke asset failed (${response.status})`);
        return;
      }
      onReady();
    } catch {
      onError('Smoke asset failed');
    }
  }

  function getCanonicalRuntimeUrl(): string | null {
    if (typeof window === 'undefined') return null;
    const canonical = window.__HTREE_CANONICAL_URL__;
    if (typeof canonical === 'string' && canonical.trim()) {
      return canonical.trim();
    }
    try {
      const queryCanonical = new URLSearchParams(window.location.search).get('iris_htree_canonical');
      if (typeof queryCanonical === 'string' && queryCanonical.trim()) {
        return queryCanonical.trim();
      }
    } catch {
      // Ignore invalid search params and fall back to the current location.
    }
    return window.location.href;
  }

  function resolveCurrentTree(): { npub: string; treeName: string } | null {
    const runtimeUrl = getCanonicalRuntimeUrl();
    if (!runtimeUrl) return null;
    let parsed: URL;
    try {
      parsed = new URL(runtimeUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'htree:') return null;
    const npub = parsed.host;
    if (!npub.startsWith('npub1')) return null;
    const parts = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    if (parts.length < 2) return null;
    const treeName = parts.slice(0, -1).join('/');
    return treeName ? { npub, treeName } : null;
  }

  function updateStatus(): void {
    if (imageError || videoError) {
      status = [imageError, videoError].filter(Boolean).join(' | ');
      return;
    }
    if (imageReady && videoReady) {
      status = 'Smoke image ready. Smoke video ready.';
      return;
    }
    if (imageReady) {
      status = 'Smoke image ready. Waiting for smoke video.';
      return;
    }
    if (videoReady) {
      status = 'Waiting for smoke image. Smoke video ready.';
      return;
    }
    status = 'Waiting for smoke assets';
  }

  function handleImageLoad(): void {
    imageReady = true;
    imageError = '';
    updateStatus();
  }

  function handleImageError(): void {
    if (imageReady) return;
    imageReady = false;
    imageError = 'Smoke image failed';
    updateStatus();
  }

  function handleVideoReady(): void {
    videoReady = true;
    videoError = '';
    updateStatus();
  }

  function handleVideoError(): void {
    if (videoReady) return;
    videoReady = false;
    videoError = 'Smoke video failed';
    updateStatus();
  }

  onMount(() => {
    if (!enabled) return;
    const currentTree = resolveCurrentTree();
    if (!currentTree) {
      status = 'Smoke mode requires htree://npub.../tree/index.html';
      return;
    }
    imageUrl = getNpubFileUrl(currentTree.npub, currentTree.treeName, 'iris-logo.png');
    videoUrl = getNpubFileUrl(currentTree.npub, currentTree.treeName, 'smoke-video.webm');
    updateStatus();
    void probeAsset(imageUrl, handleImageLoad, (message) => {
      imageReady = false;
      imageError = message;
      updateStatus();
    });
    void probeAsset(videoUrl, handleVideoReady, (message) => {
      videoReady = false;
      videoError = message;
      updateStatus();
    });
  });
</script>

{#if enabled}
  <section class="smoke-panel border-b border-border bg-surface-1 px-4 py-3" data-testid="smoke-media-panel">
    <div class="flex flex-col gap-3 md:flex-row md:items-start md:gap-4">
      <div class="flex-1 min-w-0">
        <div class="text-xs uppercase tracking-[0.2em] text-text-3">Smoke Check</div>
        <div class="mt-1 text-sm text-text-1">{status}</div>
        <div class="mt-1 text-xs text-text-3">
          {#if imageReady}Smoke image ready.{:else if imageError}{imageError}.{:else}Waiting for smoke image.{/if}

          {#if videoReady}Smoke video ready.{:else if videoError}{videoError}.{:else}Waiting for smoke video.{/if}
        </div>
      </div>
      <div class="flex gap-3 items-start">
        <div class="w-24 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-2">
          {#if imageUrl}
            <img
              src={imageUrl}
              alt=""
              data-testid="smoke-image"
              class="block h-16 w-full object-contain p-2"
              onload={handleImageLoad}
              onerror={handleImageError}
            />
          {/if}
        </div>
        <div class="w-36 shrink-0 overflow-hidden rounded-lg border border-border bg-black">
          {#if videoUrl}
            <video
              src={videoUrl}
              data-testid="smoke-video"
              class="block aspect-video h-auto w-full"
              muted
              autoplay
              playsinline
              preload="auto"
              onloadeddata={handleVideoReady}
              oncanplay={handleVideoReady}
              onerror={handleVideoError}
            ></video>
          {/if}
        </div>
      </div>
    </div>
  </section>
{/if}
