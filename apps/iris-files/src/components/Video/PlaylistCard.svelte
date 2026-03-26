<script lang="ts">
  /**
   * PlaylistCard - Card for displaying a playlist in grids
   * Shows thumbnail with YouTube-style stacked effect and playlist overlay
   */
  import type { CID } from '@hashtree/core';
  import { Avatar, Name } from '../User';
  import { extractDominantColor, rgbToRgba, type RGB } from '../../utils/colorExtract';
  import { formatTimeAgo } from '../../utils/format';
  import { getStableThumbnailCandidateUrls, onHtreePrefixReady } from '../../lib/mediaUrl';
  import VideoThumbnail from './VideoThumbnail.svelte';

  interface Props {
    href: string;
    title: string;
    videoCount: number;
    thumbnailUrl?: string | null;
    ownerNpub?: string | null;
    treeName?: string | null;
    videoId?: string | null;
    rootCid?: CID | null;
    rootHashHex?: string | null;
    allowAliasFallback?: boolean;
    ownerPubkey?: string | null;
    visibility?: string;
    hideAuthor?: boolean;
    timestamp?: number | null;
    themeHover?: boolean;
  }

  let {
    href,
    title,
    videoCount,
    thumbnailUrl,
    ownerNpub,
    treeName,
    videoId = null,
    rootCid = null,
    rootHashHex = null,
    allowAliasFallback = true,
    ownerPubkey,
    visibility,
    hideAuthor = false,
    timestamp,
    themeHover = false,
  }: Props = $props();

  let htreePrefixVersion = $state(0);
  onHtreePrefixReady(() => {
    htreePrefixVersion += 1;
  });

  let thumbnailUrls = $derived.by(() => {
    void htreePrefixVersion;
    return getStableThumbnailCandidateUrls({
      thumbnailUrl,
      rootCid,
      npub: ownerNpub,
      treeName,
      videoId: videoId || undefined,
      hashPrefix: rootHashHex?.slice(0, 8) || undefined,
      allowAliasFallback,
      preferAliasFallback: !thumbnailUrl,
    });
  });

  // Extract dominant color from thumbnail for hover effect
  let themeColor = $state<RGB | null>(null);

  $effect(() => {
    if (!themeHover) return;
    const url = thumbnailUrls[0] ?? null;
    if (!url) return;

    themeColor = null;
    extractDominantColor(url).then(color => {
      themeColor = color;
    });
  });

  let hoverStyle = $derived(themeColor ? `--hover-color: ${rgbToRgba(themeColor, 0.15)};` : '');
</script>

<a {href} class="playlist-card relative block no-underline group isolate overflow-visible" style={hoverStyle}>
  <div class="playlist-thumb relative aspect-video rounded-lg overflow-hidden z-10">
    <!-- Stacked effect (background cards) -->
    <div class="absolute -right-1 -top-1 w-full h-full bg-surface-3 rounded-lg"></div>
    <div class="absolute -right-0.5 -top-0.5 w-full h-full bg-surface-2 rounded-lg"></div>

    <!-- Main thumbnail -->
    <div class="absolute inset-0 bg-surface-2 rounded-lg overflow-hidden">
      <VideoThumbnail
        src={thumbnailUrls[0] ?? null}
        fallbackImageUrls={thumbnailUrls.slice(1)}
        fallbackTitle={title}
        fallbackSubtitle={`${videoCount} video${videoCount === 1 ? '' : 's'}`}
        fallbackSeed={`${ownerNpub ?? ''}/${treeName ?? title}`}
        class="w-full h-full"
      />

      <!-- Playlist count overlay (right side like YouTube) -->
      <div class="absolute right-0 top-0 h-full w-24 bg-black/80 flex flex-col items-center justify-center">
        <span class="text-white text-lg font-medium">{videoCount}</span>
        <span class="i-lucide-list-video text-white text-xl mt-1"></span>
      </div>

      <!-- Hover overlay -->
      <div class="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors"></div>
    </div>
  </div>

  <!-- Info - compact like YouTube VideoCard -->
  <div class="pt-2 pb-1 flex gap-2 relative z-10">
    {#if ownerPubkey && !hideAuthor}
      <div class="shrink-0">
        <Avatar pubkey={ownerPubkey} size={36} />
      </div>
    {/if}
    <div class="min-w-0 flex-1">
      <h3 class="text-base font-medium text-text-1 line-clamp-2 leading-tight">
        {title}
      </h3>
      <div class="flex items-center gap-1 text-sm text-text-3 mt-0.5">
        {#if ownerPubkey && !hideAuthor}
          <Name pubkey={ownerPubkey} />
          <span class="opacity-70">·</span>
        {/if}
        <span class="opacity-70">{videoCount} video{videoCount === 1 ? '' : 's'}</span>
        {#if timestamp}
          <span class="opacity-70">·</span>
          <span class="opacity-70">{formatTimeAgo(timestamp)}</span>
        {/if}
        {#if visibility && visibility !== 'public'}
          <span class="opacity-70">·</span>
          <span class="capitalize opacity-70">{visibility}</span>
        {/if}
      </div>
    </div>
  </div>
</a>

<style>
  .playlist-card::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 12px;
    background: transparent;
    transition: all 0.3s ease-out;
    pointer-events: none;
    z-index: -1;
  }

  .playlist-card:hover::before {
    inset: -12px;
    background: var(--hover-color, rgba(255, 255, 255, 0.08));
  }

  .playlist-thumb {
    transition: border-radius 0.3s ease-out;
  }

  .playlist-card:hover .playlist-thumb {
    border-radius: 0;
  }
</style>
