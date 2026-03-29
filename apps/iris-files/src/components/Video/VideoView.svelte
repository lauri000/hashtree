<script lang="ts">
  /**
   * VideoView - Video player page
   * Shows video player, metadata, owner info, and comments
   *
   * Uses Service Worker streaming via /htree/ URLs (no blob URLs!)
   */
  import { get } from 'svelte/store';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { nip19 } from 'nostr-tools';
  import { getTree } from '../../store';
  import { ndk, nostrStore, npubToPubkey } from '../../nostr';
  import { treeRootStore, createTreesStore, routeStore, invalidateTreeRoot, waitForTreeRoot, type TreeEntry } from '../../stores';
  import ShareButton from '../ShareButton.svelte';
  import { open as openBlossomPushModal } from '../Modals/BlossomPushModal.svelte';
  import { open as openAddToPlaylistModal } from '../Modals/AddToPlaylistModal.svelte';
  import type { TreeVisibility } from '@hashtree/core';
  import { deleteTree } from '../../nostr';
  import { updateLocalRootCacheHex } from '../../treeRootCache';
  import {
    addRecent,
    updateVideoPosition,
    getVideoPosition,
    clearVideoPosition,
    updateRecentLabel,
    updateRecentDuration,
    removeRecentByTreeName,
  } from '../../stores/recents';
  import { recordDeletedVideo } from '../../stores/videoDeletes';
  import { FollowButton } from '../User';
  import VideoDetails from './VideoDetails.svelte';
  import VideoComments from './VideoComments.svelte';
  import PlaylistSidebar from './PlaylistSidebar.svelte';
  import FeedSidebar from './FeedSidebar.svelte';
  import AmbientGlow from './AmbientGlow.svelte';
  import { ambientColor } from '../../stores/ambientGlow';
  import { getFollowers, socialGraphStore } from '../../utils/socialGraph';
  import { currentPlaylist, loadPlaylist, playNext, repeatMode, shuffleEnabled } from '../../stores/playlist';
  import type { CID } from '@hashtree/core';
  import { toHex, nhashEncode } from '@hashtree/core';
  import { getHtreePrefix, getNhashFileUrl, getStableFileUrl, getStablePathUrl, getStableResolvedMediaUrls, getStableThumbnailUrl, onHtreePrefixReady } from '../../lib/mediaUrl';
  import { logHtreeDebug } from '../../lib/htreeDebug';
  import { ensureMediaStreamingReady } from '../../lib/mediaStreamingSetup';
  import { NDKEvent, type NDKFilter } from 'ndk';
  import { VideoZapButton } from '../Zaps';
  import { formatTimeAgo } from '../../utils/format';
  import { settingsStore } from '../../stores/settings';
  import { buildPlaylistRedirectHash, consumePendingPlaylistRedirect, isActiveVideoLoad, rememberPendingPlaylistRedirect } from './videoLoadGuard';
  import { resolveProtectedVideoState } from './videoAccess';
  import { buildVideoLoadKey } from './videoLoadKey';
  import { findPlayableMediaEntry, isAudioMediaFileName, PREFERRED_PLAYABLE_MEDIA_FILENAMES } from '../../lib/playableMedia';
  import { resolveReadableVideoRoot } from '../../lib/readableVideoRoot';
  import { readDirectPlayableMediaFileName } from '../../lib/directPlayableRoot';
  import { resolveFeedVideoRootCidAsync } from '../../lib/videoFeedRoot';
  import { getVideoDisplayTitle } from '../../lib/videoDisplayTitle';
  import { readVideoDirectoryMetadata } from '../../lib/videoMetadata';
  import { sanitizeVideoDescription, sanitizeVideoTitle } from '../../lib/videoText';
  import { setRecentVideoCardInfo } from '../../stores/homeFeedCache';
  import {
    buildTreeEventPermalink,
    ensureTreeEventSnapshotForRoot,
    getCachedTreeEventSnapshot,
    snapshotMatchesRootCid,
  } from '../../lib/treeEventSnapshots';

  let deleting = $state(false);
  let editing = $state(false);
  let saving = $state(false);
  let editTitle = $state('');
  let editDescription = $state('');

  // Like state
  const likes = new SvelteSet<string>(); // Set of pubkeys who liked
  let userLiked = $state(false);
  let liking = $state(false);

  // Playlist state
  let showPlaylistSidebar = $state(true);
  let playlist = $derived($currentPlaylist);
  let repeat = $derived($repeatMode);

  // Mobile comments toggle (closed by default on mobile)
  let mobileCommentsOpen = $state(false);
  let commentCount = $state(0);
  let workerRootSyncSignature = $state<string | null>(null);

  // Thumbnail color for description box background
  let thumbnailColor = $state<{ r: number; g: number; b: number } | null>(null);
  let videoThumbnailUrl = $state<string | null>(null);
  let displayedRouteKey = $state<string | null>(null);

  // Theater mode (from settings)
  let theaterMode = $derived($settingsStore.video.theaterMode);
  function toggleTheaterMode() {
    settingsStore.setVideoSettings({ theaterMode: !theaterMode });
  }
  let shuffle = $derived($shuffleEnabled);

  interface Props {
    npub?: string;
    treeName?: string;   // Full tree name from router (e.g., "videos/koiran kanssa")
    wild?: string;       // Additional path after tree name (e.g., "videoId" for playlists)
  }

  let { npub, treeName: treeNameProp, wild }: Props = $props();

  // Tree name comes directly from router param (already decoded, includes "videos/")
  // wild contains additional path for playlist videos
  let videoPath = $derived.by(() => {
    if (!treeNameProp) return '';
    // Remove "videos/" prefix to get the video/playlist name
    const basePath = treeNameProp.startsWith('videos/') ? treeNameProp.slice(7) : treeNameProp;
    // Append wild path if present (for playlist videos)
    return wild ? `${basePath}/${wild}` : basePath;
  });
  let pathParts = $derived(videoPath.split('/'));
  let isPlaylistVideo = $derived(pathParts.length > 1);

  // For playlists, the tree is the channel (parent), not the full path
  let channelName = $derived(isPlaylistVideo ? pathParts.slice(0, -1).join('/') : null);
  let currentVideoId = $derived(isPlaylistVideo ? pathParts[pathParts.length - 1] : null);

  // The actual tree name to resolve - use prop directly or construct from channel
  // - Single video: videos/VideoTitle (treeNameProp)
  // - Playlist video: videos/ChannelName (the video is a subdirectory within)
  let treeName = $derived.by(() => {
    if (!treeNameProp) return undefined;
    if (isPlaylistVideo && channelName) {
      return `videos/${channelName}`;
    }
    return treeNameProp;
  });

  let videoSrc = $state<string>('');  // SW URL (not blob!)
  let videoFileName = $state<string>('');  // For MIME type detection
  let videoFallbackQueue = $state<Array<{ url: string; fileName: string }>>([]);
  let loading = $state(true);
  let showLoading = $state(false);  // Delayed loading indicator
  let loadingTimer: ReturnType<typeof setTimeout> | null = null;
  let rootTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let error = $state<string | null>(null);
  let videoTitle = $state<string>('');
  let videoDescription = $state<string>('');
  let videoCreatedAt = $state<number | null>(null);  // Unix timestamp in seconds
  let videoCid = $state<CID | null>(null);  // CID of the video FILE (video.mp4)
  let videoFolderCid = $state<CID | null>(null);  // CID of the video FOLDER (contains video.mp4, title.txt, etc.)
  let videoVisibility = $state<TreeVisibility>('public');
  let treeEntries = $state<TreeEntry[]>([]);
  let videoRef: HTMLMediaElement | undefined = $state();
  let isAudioOnly = $derived(videoFileName ? isAudioMediaFileName(videoFileName) : false);
  let videoElementKey = $derived.by(() =>
    `${npub ?? ''}/${treeName ?? ''}/${currentVideoId ?? ''}:${videoFileName}:${videoSrc}`
  );
  const VIDEO_RESOLVE_TIMEOUT_MS = 10000;

  function logVideoDebug(event: string, data?: Record<string, unknown>) {
    logHtreeDebug(`video:${event}`, data);
  }

async function syncTreeRootToWorker(
  npubValue: string,
  treeNameValue: string,
  rootCidValue: CID,
  visibility: TreeVisibility
): Promise<void> {
  const signature = `${npubValue}/${treeNameValue}:${toHex(rootCidValue.hash)}:${rootCidValue.key ? toHex(rootCidValue.key) : ''}:${visibility}`;
  if (workerRootSyncSignature === signature) return;

  try {
      const { getWorkerAdapter, waitForWorkerAdapter } = await import('../../lib/workerInit');
      const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(10000);
      if (!adapter || !('setTreeRootCache' in adapter)) return;
      const cacheAdapter = adapter as {
        setTreeRootCache: (
          npub: string,
          treeName: string,
          hash: Uint8Array,
          key?: Uint8Array,
          visibility?: TreeVisibility
        ) => Promise<void>;
      };

      // Under heavy load worker bootstrap may race with initial media fetches.
      // Retry once before giving up so /htree fetches have root context.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await cacheAdapter.setTreeRootCache(
            npubValue,
            treeNameValue,
            rootCidValue.hash,
            rootCidValue.key,
            visibility
          );
          workerRootSyncSignature = signature;
          return;
        } catch (err) {
          if (attempt === 1) throw err;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    } catch (err) {
      console.warn('[VideoView] Failed to sync tree root to worker:', err);
    }
  }

  let htreePrefix = $state<string>(getHtreePrefix());
  let htreePrefixVersion = $state(0);
  onHtreePrefixReady((prefix) => {
    htreePrefix = prefix;
    htreePrefixVersion += 1;
    logVideoDebug('prefix:ready', { prefix });
  });

  function buildStableVideoCandidates(
    rootCidValue: CID | null | undefined,
    npub: string,
    treeName: string,
    videoPathPrefix: string,
  ) {
    return PREFERRED_PLAYABLE_MEDIA_FILENAMES.map((fileName) => ({
      fileName,
      url: getStablePathUrl({
        rootCid: rootCidValue,
        npub,
        treeName,
        path: `${videoPathPrefix}${fileName}`,
      }),
    })).filter((candidate): candidate is { fileName: string; url: string } => !!candidate.url);
  }

  function buildResolvedVideoUrl(
    rootCidValue: CID | null | undefined,
    fileCidValue: CID,
    npubValue: string,
    treeNameValue: string,
    path: string,
  ): string | null {
    const treePathUrl = getStablePathUrl({
      rootCid: rootCidValue,
      npub: npubValue,
      treeName: treeNameValue,
      path,
    });
    if (treePathUrl) {
      return treePathUrl;
    }
    return getStableFileUrl({
      cid: fileCidValue,
      npub: npubValue,
      treeName: treeNameValue,
      path,
    });
  }

  function buildResolvedVideoFallbackQueue(
    rootCidValue: CID | null | undefined,
    fileCidValue: CID,
    npubValue: string,
    treeNameValue: string,
    path: string,
    preferredUrl: string | null,
    fileName: string,
  ): Array<{ url: string; fileName: string }> {
    return getStableResolvedMediaUrls({
      rootCid: rootCidValue,
      cid: fileCidValue,
      npub: npubValue,
      treeName: treeNameValue,
      path,
    })
      .filter((url) => !!url && url !== preferredUrl)
      .map((url) => ({ url, fileName }));
  }

  function startMutableVideoFallback(
    rootCidValue: CID | null | undefined,
    npub: string,
    treeName: string,
    videoPathPrefix: string,
  ): boolean {
    const candidates = buildStableVideoCandidates(rootCidValue, npub, treeName, videoPathPrefix);
    if (candidates.length === 0) {
      logVideoDebug('fallback:skip', { reason: 'no-candidates', npub, treeName, videoPathPrefix });
      return false;
    }
    videoFallbackQueue = candidates.slice(1);
    videoFileName = candidates[0].fileName;
    videoSrc = candidates[0].url;
    loading = false;
    logVideoDebug('fallback:start', {
      mode: rootCidValue ? 'stable-root-path' : 'tree-path',
      fileName: videoFileName,
      url: videoSrc,
    });
    return true;
  }

  onMount(() => {
    logVideoDebug('mount', {
      npub: npub ?? null,
      treeName: treeName ?? null,
    });
  });

  function advanceVideoFallback(): boolean {
    if (videoFallbackQueue.length === 0) return false;
    const [next, ...rest] = videoFallbackQueue;
    videoFallbackQueue = rest;
    videoFileName = next.fileName;
    videoSrc = next.url;
    logVideoDebug('fallback:advance', {
      fileName: videoFileName,
      url: videoSrc,
    });
    return true;
  }

  function getVideoElementSnapshot(node: HTMLMediaElement | undefined): Record<string, unknown> {
    return {
      currentSrc: node?.currentSrc ?? null,
      readyState: node?.readyState ?? null,
      networkState: node?.networkState ?? null,
      paused: node?.paused ?? null,
      ended: node?.ended ?? null,
      currentTime: node ? Math.round(node.currentTime * 1000) / 1000 : null,
      duration: node && Number.isFinite(node.duration) ? Math.round(node.duration * 1000) / 1000 : null,
      errorCode: node?.error?.code ?? null,
      errorMessage: node?.error?.message ?? null,
    };
  }

  async function probeVideoSource(url: string, reason: string): Promise<void> {
    const startedAt = performance.now();
    try {
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
        cache: 'no-store',
      });
      const body = await response.arrayBuffer();
      const details = {
        reason,
        url,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type'),
        contentRange: response.headers.get('content-range'),
        contentLength: response.headers.get('content-length'),
        bytesRead: body.byteLength,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
      logVideoDebug('player:probe', details);
      if (!response.ok) {
        console.error('[VideoView] Player probe failed:', details);
      }
    } catch (err) {
      const details = {
        reason,
        url,
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Math.round(performance.now() - startedAt),
      };
      logVideoDebug('player:probe-error', details);
      console.error('[VideoView] Player probe error:', details);
    }
  }

  function attachVideoLifecycleLogging(node: HTMLMediaElement): () => void {
    const events = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'suspend', 'abort', 'emptied'];
    const listeners = events.map((eventName) => {
      const handler = () => {
        logVideoDebug(`player:${eventName}`, {
          fileName: videoFileName,
          url: videoSrc,
          ...getVideoElementSnapshot(node),
        });
      };
      node.addEventListener(eventName, handler);
      return { eventName, handler };
    });

    return () => {
      for (const { eventName, handler } of listeners) {
        node.removeEventListener(eventName, handler);
      }
    };
  }

  function handleVideoError() {
    const details = {
      fileName: videoFileName,
      url: videoSrc,
      ...getVideoElementSnapshot(videoRef),
    };
    logVideoDebug('player:error', details);
    console.error('[VideoView] Player error:', details);
    if (videoSrc) {
      void probeVideoSource(videoSrc, 'player:error');
    }
    if (advanceVideoFallback()) {
      error = null;
      return;
    }
    if (!error) {
      error = 'Video failed to load';
    }
    loading = false;
  }

  $effect(() => {
    const node = videoRef;
    const currentSrc = videoSrc;
    if (!node || !currentSrc) return;

    logVideoDebug('player:attach', {
      fileName: videoFileName,
      url: currentSrc,
      elementKey: videoElementKey,
      canPlayMp4: node.canPlayType('video/mp4'),
      canPlayWebm: node.canPlayType('video/webm'),
      ...getVideoElementSnapshot(node),
    });

    const detach = attachVideoLifecycleLogging(node);
    return () => {
      detach();
      logVideoDebug('player:detach', {
        fileName: videoFileName,
        url: currentSrc,
        elementKey: videoElementKey,
        ...getVideoElementSnapshot(node),
      });
      try {
        node.pause();
      } catch {}
      try {
        node.removeAttribute('src');
        node.load();
      } catch {}
    };
  });

  async function resolvePathWithTimeout(tree: ReturnType<typeof getTree>, cid: CID, path: string) {
    try {
      const startMs = performance.now();
      const result = await Promise.race([
        tree.resolvePath(cid, path),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), VIDEO_RESOLVE_TIMEOUT_MS)),
      ]);
      if (!result) {
        logVideoDebug('resolve:timeout', {
          path,
          elapsedMs: Math.round(performance.now() - startMs),
        });
      }
      return result ?? null;
    } catch {
      logVideoDebug('resolve:error', { path });
      return null;
    }
  }

  async function listDirectoryWithTimeout(tree: ReturnType<typeof getTree>, cid: CID) {
    try {
      const startMs = performance.now();
      const result = await Promise.race([
        tree.listDirectory(cid),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), VIDEO_RESOLVE_TIMEOUT_MS)),
      ]);
      if (!result) {
        logVideoDebug('list:timeout', {
          elapsedMs: Math.round(performance.now() - startMs),
        });
      }
      return result ?? null;
    } catch {
      logVideoDebug('list:error');
      return null;
    }
  }

  // Read saved video settings directly from localStorage (synchronous)
  function getSavedVideoSettings(): { volume: number; muted: boolean } {
    try {
      const saved = localStorage.getItem('video-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          volume: typeof parsed.volume === 'number' ? parsed.volume : 1,
          muted: typeof parsed.muted === 'boolean' ? parsed.muted : false,
        };
      }
    } catch {}
    return { volume: 1, muted: false };
  }

  // Initial values read synchronously before any rendering
  const initialVideoSettings = getSavedVideoSettings();

  // Apply saved volume/muted settings via action
  function applyVolumeSettings(node: HTMLMediaElement) {
    node.volume = initialVideoSettings.volume;
    node.muted = initialVideoSettings.muted;
  }

  // Full video path for position tracking (includes npub and videoId for playlists)
  let videoFullPath = $derived.by(() => {
    if (!npub || !treeName) return null;
    // For playlist videos, include the videoId to track each video's position separately
    if (isPlaylistVideo && currentVideoId) {
      return `/${npub}/${treeName}/${currentVideoId}`;
    }
    return `/${npub}/${treeName}`;
  });

  // Get timestamp from route params
  function getTimestampFromUrl(): number | null {
    const t = $routeStore.params.get('t');
    if (t) {
      const seconds = parseInt(t, 10);
      if (!isNaN(seconds) && seconds >= 0) return seconds;
    }
    return null;
  }

  // Track if we've restored position for this video
  let positionRestored = $state(false);

  // Restore position when video loads - prioritize URL ?t= param over saved position
  function restorePosition() {
    if (!videoRef || !videoFullPath || positionRestored) return;
    if (!videoRef.duration || videoRef.duration === 0) return;

    // Check for ?t= param first (direct link to timestamp)
    const urlTimestamp = getTimestampFromUrl();
    if (urlTimestamp !== null && videoRef.duration > urlTimestamp) {
      videoRef.currentTime = urlTimestamp;
      positionRestored = true;
      console.log('[VideoView] Seeking to URL timestamp:', urlTimestamp);
      return;
    }

    // Fall back to saved position
    const savedPosition = getVideoPosition(videoFullPath);
    if (savedPosition > 0 && videoRef.duration > savedPosition) {
      videoRef.currentTime = savedPosition;
      positionRestored = true;
      console.log('[VideoView] Restored position:', savedPosition);
    } else {
      positionRestored = true;
    }
  }

  function handleLoadedMetadata() {
    restorePosition();
    // Restore saved volume and muted state
    if (videoRef) {
      const { volume, muted } = $settingsStore.video;
      videoRef.volume = volume;
      videoRef.muted = muted;
    }
    // Save video duration to recents for display in video cards
    if (videoRef && videoRef.duration && isFinite(videoRef.duration) && videoFullPath) {
      updateRecentDuration(videoFullPath, videoRef.duration);
    }
    // Update metadata.json for own videos if duration is missing
    maybeUpdateOwnVideoMetadata();
  }

  // Save volume and muted state when user changes them
  function handleVolumeChange() {
    if (videoRef) {
      settingsStore.setVideoSettings({ volume: videoRef.volume, muted: videoRef.muted });
    }
  }

  let metadataUpdateAttempted = false;

  async function maybeUpdateOwnVideoMetadata() {
    // Only update own videos, only once per view, only if we have duration
    if (!isOwner || metadataUpdateAttempted || !videoRef?.duration || !isFinite(videoRef.duration)) return;
    if (!npub || !treeName || !rootCid) return;

    metadataUpdateAttempted = true;
    const duration = Math.round(videoRef.duration);

    try {
      const tree = getTree();

      // Find video file entry
      const entries = await tree.listDirectory(rootCid);
      const videoEntry = entries ? findPlayableMediaEntry(entries) : undefined;
      if (!videoEntry) return;

      // Get existing metadata from link entry
      const existingMeta = (videoEntry.meta as Record<string, unknown>) || {};

      // Skip if duration already exists
      if (existingMeta.duration) return;

      // Update metadata with duration
      const updatedMeta: Record<string, unknown> = {
        ...existingMeta,
        duration,
        createdAt: existingMeta.createdAt || Math.floor(Date.now() / 1000),
        title: existingMeta.title || videoTitle || treeName.replace('videos/', ''),
      };

      // Update video entry with new metadata
      const newRootCid = await tree.setEntry(
        rootCid,
        [],
        videoEntry.name,
        videoEntry.cid,
        videoEntry.size,
        videoEntry.type,
        updatedMeta
      );

      // Save updated tree
      updateLocalRootCacheHex(
        npub,
        treeName,
        toHex(newRootCid.hash),
        newRootCid.key ? toHex(newRootCid.key) : undefined,
        videoVisibility
      );

      console.log('[VideoView] Updated video entry metadata with duration:', duration);
    } catch (e) {
      console.error('[VideoView] Failed to update metadata:', e);
    }
  }

  // Also try to restore position when videoFullPath becomes available
  // (in case loadedmetadata fired before path was computed)
  $effect(() => {
    if (videoFullPath && videoRef && videoRef.readyState >= 1) {
      restorePosition();
    }
  });

  // Listen for URL changes (timestamp clicks update URL)
  $effect(() => {
    if (!videoRef) return;

    function handleHashChange() {
      const urlTimestamp = getTimestampFromUrl();
      if (urlTimestamp !== null && videoRef && videoRef.duration > urlTimestamp) {
        videoRef.currentTime = urlTimestamp;
        console.log('[VideoView] Seeking to timestamp:', urlTimestamp);
      }
    }

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  });

  // Save position on timeupdate
  function handleTimeUpdate() {
    if (!videoRef || !videoFullPath) return;
    updateVideoPosition(videoFullPath, videoRef.currentTime);
  }

  // Clear position when video ends and handle auto-play/repeat
  function handleEnded() {
    if (videoFullPath) {
      clearVideoPosition(videoFullPath);
    }

    // Handle repeat mode
    if (repeat === 'one') {
      // Repeat current video
      if (videoRef) {
        videoRef.currentTime = 0;
        videoRef.play();
      }
      return;
    }

    // Auto-play next video (always enabled for playlists, like YouTube)
    if (playlist && playlist.items.length > 1) {
      // Check if we're at the end and repeat is off
      const isLastVideo = playlist.currentIndex === playlist.items.length - 1;
      const shouldWrap = repeat === 'all' || shuffle;

      if (isLastVideo && !shouldWrap && !shuffle) {
        // End of playlist, repeat off, not shuffling - stop
        console.log('[VideoView] End of playlist, stopping');
        return;
      }

      const nextUrl = playNext({ wrap: shouldWrap });
      if (nextUrl) {
        console.log('[VideoView] Auto-playing next video');
        window.location.hash = nextUrl;
      }
    }
  }

  // Derive owner pubkey
  let ownerPubkey = $derived.by(() => {
    if (!npub) return null;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') return decoded.data as string;
    } catch {}
    return null;
  });

  let currentPlaylistItemTitle = $derived.by(() => {
    if (!playlist || !currentVideoId || !npub || !treeName) return '';
    if (playlist.npub !== npub || playlist.treeName !== treeName) return '';
    return playlist.items.find((item) => item.id === currentVideoId)?.title?.trim() ?? '';
  });

  // Keep synthetic playlist folder ids out of the UI while metadata is still loading.
  let title = $derived(getVideoDisplayTitle({
    videoTitle,
    playlistItemTitle: currentPlaylistItemTitle,
    currentVideoId,
    videoPath,
    treeName,
  }));

  // Current user
  let currentUserNpub = $derived($nostrStore.npub);
  let userPubkey = $derived($nostrStore.pubkey);
  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let isOwner = $derived(npub === currentUserNpub);

  // Social graph for known followers (like YouTube subscriber count)
  let graphVersion = $derived($socialGraphStore.version);
  let knownFollowers = $derived.by(() => {
    graphVersion; // Subscribe to changes
    return ownerPubkey ? getFollowers(ownerPubkey) : new Set();
  });

  // Get root CID from treeRootStore (handles linkKey decryption)
  let rootCid = $state<CID | null>(null);
  let routeRootOverride = $state<CID | null>(null);
  let routeRootOverrideKey = $state<string | null>(null);
  const rootCidUnsub = treeRootStore.subscribe((next) => {
    rootCid = next;
    logVideoDebug('root:store', {
      hasCid: !!next,
      hash: next ? toHex(next.hash).slice(0, 16) : null,
    });
  });
  onDestroy(() => {
    rootCidUnsub();
  });

  function getRouteRootKey(
    npubValue: string | null | undefined,
    treeNameValue: string | null | undefined,
    videoIdValue: string | null | undefined,
  ): string | null {
    if (!npubValue || !treeNameValue) return null;
    return `${npubValue}/${treeNameValue}/${videoIdValue ?? ''}`;
  }

  function setRouteRootOverride(
    routeKey: string | null,
    nextRoot: CID | null,
    source: string,
  ): void {
    if (!routeKey || !nextRoot) return;
    routeRootOverrideKey = routeKey;
    routeRootOverride = nextRoot;
    logVideoDebug('root:override', {
      routeKey,
      source,
      hash: toHex(nextRoot.hash).slice(0, 8),
    });
  }

  let effectiveRouteRootCid = $derived.by(() => {
    const routeKey = getRouteRootKey(npub, treeName, currentVideoId);
    if (routeKey && routeRootOverrideKey === routeKey && routeRootOverride) {
      return routeRootOverride;
    }
    return rootCid;
  });

  $effect(() => {
    const routeKey = getRouteRootKey(npub, treeName, currentVideoId);
    if (!routeKey) {
      routeRootOverride = null;
      routeRootOverrideKey = null;
      return;
    }
    if (routeRootOverrideKey && routeRootOverrideKey !== routeKey) {
      routeRootOverride = null;
    }
    routeRootOverrideKey = routeKey;
  });

  $effect(() => {
    const routeKey = getRouteRootKey(npub, treeName, currentVideoId);
    const currentStoreRoot = rootCid;
    if (!routeKey || !currentStoreRoot) return;
    if (routeRootOverrideKey === routeKey && routeRootOverride) return;
    setRouteRootOverride(routeKey, currentStoreRoot, 'store-first');
  });

  let lastRootHash = $state<string | null>(null);
  let pendingFallbackRootVideoKey = $state<string | null>(null);

  $effect(() => {
    const cid = effectiveRouteRootCid;
    const currentHash = cid ? toHex(cid.hash).slice(0, 16) : null;
    if (currentHash === lastRootHash) return;
    lastRootHash = currentHash;
    logVideoDebug('root:change', {
      hasCid: !!cid,
      hash: currentHash,
      npub,
      treeName,
    });
  });

  // Generate nhash for permalink - uses video file CID (not root dir) so same content = same link
  let videoNhash = $derived.by(() => {
    if (!videoCid) return undefined;
    return nhashEncode(videoCid);
  });
  let snapshotPermalinkHref = $state<string | null>(null);

  $effect(() => {
    const currentNpub = npub;
    const currentTreeName = treeName;
    const currentVideoIdValue = currentVideoId;
    const linkKey = $routeStore.params.get('k');
    const currentRootCid = effectiveRouteRootCid;

    if (!currentNpub || !currentTreeName) {
      snapshotPermalinkHref = videoNhash ? `#/${videoNhash}` : null;
      return;
    }

    if (!currentRootCid?.hash) {
      snapshotPermalinkHref = videoNhash ? `#/${videoNhash}` : null;
      return;
    }

    const permalinkPath = currentVideoIdValue ? [currentVideoIdValue] : [];
    const cached = getCachedTreeEventSnapshot(currentNpub, currentTreeName);
    if (cached && snapshotMatchesRootCid(cached, currentRootCid)) {
      snapshotPermalinkHref = buildTreeEventPermalink(cached, permalinkPath, linkKey);
      return;
    }

    snapshotPermalinkHref = null;
    let cancelled = false;
    ensureTreeEventSnapshotForRoot(currentNpub, currentTreeName, currentRootCid).then((snapshot) => {
      if (!cancelled) {
        snapshotPermalinkHref = snapshot
          ? buildTreeEventPermalink(snapshot, permalinkPath, linkKey)
          : (videoNhash ? `#/${videoNhash}` : null);
      }
    }).catch(() => {
      if (!cancelled) {
        snapshotPermalinkHref = videoNhash ? `#/${videoNhash}` : null;
      }
    });
    return () => { cancelled = true; };
  });

  // Subscribe to trees store to get visibility and createdAt from Nostr event
  $effect(() => {
    const currentNpub = npub;
    const currentTreeName = treeName;
    if (!currentNpub || !currentTreeName) return;

    const store = createTreesStore(currentNpub);
    const unsub = store.subscribe(trees => {
      treeEntries = trees;
      const tree = trees.find(t => t.name === currentTreeName);
      if (tree?.visibility) {
        untrack(() => {
          videoVisibility = tree.visibility as TreeVisibility;
        });
      }
      // Use Nostr event createdAt if video metadata doesn't have it
      if (tree?.createdAt && !videoCreatedAt) {
        untrack(() => {
          videoCreatedAt = tree.createdAt!;
        });
      }
    });
    return unsub;
  });

  // Effective visibility: infer from k param in URL if trees store doesn't have it
  // k param in URL means link-visible
  let effectiveVisibility = $derived.by(() => {
    if (videoVisibility !== 'public') return videoVisibility;
    if ($routeStore.params.get('k')) return 'link-visible' as TreeVisibility;
    return videoVisibility;
  });

  let currentTreeEntry = $derived.by(() => {
    if (!treeName) return null;
    return treeEntries.find((tree) => tree.name === treeName) ?? null;
  });

  let routeLinkKey = $derived($routeStore.params.get('k'));
  let resolvedTreeVisibility = $derived.by(() =>
    currentTreeEntry?.visibility ?? (isOwner && videoVisibility !== 'public' ? videoVisibility : undefined)
  );
  let protectedVideoState = $derived(resolveProtectedVideoState({
    isOwner,
    visibility: resolvedTreeVisibility,
    hasDecryptionKey: !!effectiveRouteRootCid?.key,
    hasLinkKey: !!routeLinkKey,
  }));

  $effect(() => {
    const protectedState = protectedVideoState;
    const path = videoPath;
    if (!protectedState || !path) return;

    videoSrc = '';
    videoFileName = '';
    videoCid = null;
    videoFolderCid = null;
    videoThumbnailUrl = null;
    videoTitle = '';
    videoDescription = '';
    videoCreatedAt = null;
    videoFallbackQueue = [];
    loadedVideoKey = null;
    displayedRouteKey = path;
    pendingFallbackRootVideoKey = null;
    error = null;
    loading = false;
    positionRestored = false;
  });

  // Track what we've loaded to avoid unnecessary reloads
  let loadedVideoKey = $state<string | null>(null);
  let lastPrefixVersion = $state(0);
  let missingPropsLogged = $state(false);
  let loadEffectRuns = $state(0);
  const staleRootRefreshAttempts = new SvelteSet<string>();

  // Load video when rootCid or videoPath changes
  // For playlist videos, rootCid is the same but videoPath changes
  $effect(() => {
    const cid = effectiveRouteRootCid;
    const path = videoPath; // Subscribe to videoPath changes
    const isPlaylist = isPlaylistVideo; // Capture reactively
    const protectedState = protectedVideoState;
    const currentNpub = npub;
    const currentTreeName = treeName;
    const currentVideoIdValue = currentVideoId;
    const prefixVersion = htreePrefixVersion;
    const runCount = untrack(() => {
      loadEffectRuns += 1;
      return loadEffectRuns;
    });
    logVideoDebug('load:effect', {
      run: runCount,
      npub: currentNpub ?? null,
      treeName: currentTreeName ?? null,
      hasRoot: !!cid,
      hasSrc: !!videoSrc,
    });
    if (!currentNpub || !currentTreeName) {
      if (!missingPropsLogged) {
        logVideoDebug('load:skip', {
          npub: currentNpub ?? null,
          treeName: currentTreeName ?? null,
        });
        missingPropsLogged = true;
      }
      return;
    }
    missingPropsLogged = false;

    if (protectedState) {
      logVideoDebug('load:skip-protected', {
        npub: currentNpub,
        treeName: currentTreeName,
        visibility: protectedState.visibility,
        hasLinkKey: protectedState.hasLinkKey,
      });
      return;
    }

    const routeKey = path;

    // Build a key to identify this specific video source
    const videoKey = buildVideoLoadKey(cid, path);

    if (routeKey === displayedRouteKey && !!videoSrc && !cid) {
      error = null;
      logVideoDebug('load:hold-existing-no-root', {
        routeKey,
      });
      return;
    }

    if (routeKey === displayedRouteKey && !!videoSrc && !!cid && videoKey !== loadedVideoKey) {
      error = null;
      loading = false;
      loadedVideoKey = videoKey;
      lastPrefixVersion = prefixVersion;
      logVideoDebug('load:refresh-existing', {
        routeKey,
        rootCid: toHex(cid.hash).slice(0, 8),
      });
      untrack(() => loadVideo(cid, videoKey));
      return;
    }

    // Skip reload if we already loaded this exact video
    if (videoKey === loadedVideoKey) {
      if (prefixVersion !== lastPrefixVersion) {
        lastPrefixVersion = prefixVersion;
        if (videoSrc && videoFileName) {
          const nextSrc = videoCid
            ? buildResolvedVideoUrl(
                videoFolderCid ?? cid,
                videoCid,
                currentNpub,
                currentTreeName,
                videoFolderCid ? videoFileName : `${videoPathPrefix}${videoFileName}`,
              )
            : null;
          if (nextSrc && videoSrc !== nextSrc) {
            videoSrc = nextSrc;
            error = null;
          }
        }
      }
      return;
    }

    logVideoDebug('load:reset', {
      npub: currentNpub,
      treeName: currentTreeName,
      videoId: currentVideoIdValue,
      hasRoot: !!cid,
      prefix: htreePrefix,
    });

    // Reset state for new video
    videoSrc = '';
    videoFileName = '';
    videoCid = null;
    videoFolderCid = null;
    videoThumbnailUrl = null;
    videoTitle = '';
    videoDescription = '';
    videoCreatedAt = null;
    loading = true;
    error = null;
    positionRestored = false;
    videoFallbackQueue = [];
    loadedVideoKey = videoKey;
    displayedRouteKey = routeKey;
    lastPrefixVersion = prefixVersion;

    // Clear playlist if navigating to a non-playlist video
    if (!isPlaylist) {
      untrack(() => {
        currentPlaylist.set(null);
      });
    }

    if (cid) {
      untrack(() => loadVideo(cid, videoKey));
      return;
    }

    if (pendingFallbackRootVideoKey !== videoKey) {
      pendingFallbackRootVideoKey = videoKey;
      void (async () => {
        try {
          const routeRootKey = getRouteRootKey(currentNpub, currentTreeName, currentVideoIdValue);
          const fallbackSeedRoot = await resolveFeedVideoRootCidAsync({
            ownerNpub: currentNpub,
            treeName: currentTreeName,
          }, 12000, { requireAuthoritative: true });
          if (!fallbackSeedRoot) return;
          if (untrack(() => !!protectedVideoState)) return;
          if (!isActiveVideoLoad(loadedVideoKey, videoKey)) return;
          if (getRouteRootKey(npub, treeName, currentVideoId) !== routeRootKey || effectiveRouteRootCid) {
            return;
          }
          setRouteRootOverride(routeRootKey, fallbackSeedRoot, 'feed-fallback-seed');
          logVideoDebug('root:fallback-resolved', {
            npub: currentNpub,
            treeName: currentTreeName,
            hash: toHex(fallbackSeedRoot.hash).slice(0, 8),
          });
        } finally {
          if (pendingFallbackRootVideoKey === videoKey) {
            pendingFallbackRootVideoKey = null;
          }
        }
      })();
    }
  });

  // Delayed loading indicator - only show after 2 seconds
  $effect(() => {
    if (!loading) {
      // Video loaded - clear timer and hide loading
      if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
      }
      showLoading = false;
    } else if (!loadingTimer && !showLoading) {
      // Still loading - start timer to show indicator
      loadingTimer = setTimeout(() => {
        showLoading = true;
        loadingTimer = null;
      }, 2000);
    }

    return () => {
      if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
      }
    };
  });

  // Timeout for tree root resolution - show error if not resolved within 15 seconds
  $effect(() => {
    const cid = effectiveRouteRootCid;
    const currentTreeName = treeName;
    const protectedState = protectedVideoState;

    // Clear any existing timeout
    if (rootTimeoutTimer) {
      clearTimeout(rootTimeoutTimer);
      rootTimeoutTimer = null;
    }

    if (cid) {
      // Root resolved - no timeout needed
      return;
    }

    if (!currentTreeName) {
      // No tree name - nothing to resolve
      return;
    }

    if (protectedState) {
      return;
    }

    // Start timeout for root resolution (e.g., Nostr event not found on relays)
    rootTimeoutTimer = setTimeout(() => {
      if (!effectiveRouteRootCid && loading && !error) {
        error = 'Video not found. The video metadata may not be available from your relays.';
        loading = false;
        console.warn('[VideoView] Tree root resolution timeout for:', currentTreeName);
      }
    }, 15000);

    return () => {
      if (rootTimeoutTimer) {
        clearTimeout(rootTimeoutTimer);
        rootTimeoutTimer = null;
      }
    };
  });

  // No blob URL cleanup needed - using SW URLs

  async function loadVideo(rootCidParam: CID, expectedLoadKey: string) {
    // Capture reactive values at the start - they may change during async operations
    // due to navigation. Using captured values ensures consistent behavior.
    const capturedNpub = npub;
    const capturedTreeName = treeName;
    const capturedIsPlaylistVideo = isPlaylistVideo;
    const capturedVideoId = currentVideoId;
    const capturedVisibility = effectiveVisibility;
    const capturedRouteRootKey = getRouteRootKey(capturedNpub, capturedTreeName, capturedVideoId);

    if (!capturedNpub || !capturedTreeName) return;

    function isStaleLoad(stage: string): boolean {
      if (isActiveVideoLoad(loadedVideoKey, expectedLoadKey)) {
        return false;
      }
      logVideoDebug('load:stale', {
        stage,
        expected: expectedLoadKey,
        active: loadedVideoKey,
      });
      return true;
    }

    error = null;
    logVideoDebug('load:start', {
      npub: capturedNpub,
      treeName: capturedTreeName,
      videoId: capturedVideoId,
      rootCid: toHex(rootCidParam.hash).slice(0, 8),
      prefix: htreePrefix,
    });

    const streamingReady = await ensureMediaStreamingReady().catch((err) => {
      console.warn('[VideoView] Media streaming setup failed:', err);
      return false;
    });
    if (isStaleLoad('streaming-ready')) return;
    if (!streamingReady) {
      error = 'Video streaming unavailable. Please reload and try again.';
      loading = false;
      return;
    }

    await syncTreeRootToWorker(
      capturedNpub,
      capturedTreeName,
      rootCidParam,
      capturedVisibility ?? 'public'
    );
    if (isStaleLoad('sync-root')) return;

    const tree = getTree();

    function syncResolvedRootCache(nextRoot: CID): void {
      void syncTreeRootToWorker(
        capturedNpub,
        capturedTreeName,
        nextRoot,
        capturedVisibility ?? 'public'
      );
    }

    async function retryWithFreshTreeRoot(reason: string): Promise<boolean> {
      if (staleRootRefreshAttempts.has(expectedLoadKey)) {
        return false;
      }
      staleRootRefreshAttempts.add(expectedLoadKey);
      logVideoDebug('load:refresh-root', {
        npub: capturedNpub,
        treeName: capturedTreeName,
        reason,
      });
      loadedVideoKey = null;
      await invalidateTreeRoot(capturedNpub, capturedTreeName);
      const refreshedRoot = await waitForTreeRoot(capturedNpub, capturedTreeName, 12000);
      if (isStaleLoad('refresh-root')) return true;
      if (!refreshedRoot) {
        return false;
      }
      setRouteRootOverride(capturedRouteRootKey, refreshedRoot, `refresh:${reason}`);
      syncResolvedRootCache(refreshedRoot);
      logVideoDebug('load:refresh-root:resolved', {
        npub: capturedNpub,
        treeName: capturedTreeName,
        rootCid: toHex(refreshedRoot.hash).slice(0, 8),
      });
      return true;
    }

    const readableRootPromise = capturedIsPlaylistVideo
      ? null
      : resolveReadableVideoRoot({
          rootCid: rootCidParam,
          npub: capturedNpub,
          treeName: capturedTreeName,
          videoId: capturedVideoId,
          priority: 'foreground',
        });
    let effectiveRootCid = rootCidParam;
    if (capturedIsPlaylistVideo) {
      effectiveRootCid = await resolveReadableVideoRoot({
        rootCid: rootCidParam,
        npub: capturedNpub,
        treeName: capturedTreeName,
        videoId: capturedVideoId,
        priority: 'foreground',
      });
      if (isStaleLoad('resolve-readable-root')) return;
      if (effectiveRootCid && rootCidParam && toHex(effectiveRootCid.hash) !== toHex(rootCidParam.hash)) {
        setRouteRootOverride(capturedRouteRootKey, effectiveRootCid, 'readable-fallback');
        logVideoDebug('load:root-fallback', {
          npub: capturedNpub,
          treeName: capturedTreeName,
          videoId: capturedVideoId,
          fromHash: toHex(rootCidParam.hash).slice(0, 8),
          toHash: toHex(effectiveRootCid.hash).slice(0, 8),
        });
        syncResolvedRootCache(effectiveRootCid);
      }
    }

    let videoDirCid = effectiveRootCid ?? rootCidParam;
    let videoPathPrefix = capturedIsPlaylistVideo && capturedVideoId ? `${capturedVideoId}/` : '';
    let resolvedVideo = false;

    async function applyResolvedVideo(entryCid: CID, fileName: string): Promise<boolean> {
      if (isStaleLoad(`apply:${fileName}`)) return false;
      videoCid = entryCid;
      videoFileName = fileName;
      error = null;
      const nextSrc = buildResolvedVideoUrl(
        videoDirCid,
        entryCid,
        capturedNpub,
        capturedTreeName,
        fileName,
      );
      if (nextSrc && videoSrc !== nextSrc) {
        videoSrc = nextSrc;
      }
      const fallbackQueue = buildResolvedVideoFallbackQueue(
        videoDirCid,
        entryCid,
        capturedNpub,
        capturedTreeName,
        fileName,
        nextSrc,
        fileName,
      );
      videoFallbackQueue = fallbackQueue;
      loading = false;
      resolvedVideo = true;
      logVideoDebug('load:resolved', {
        fileName,
        url: nextSrc,
        fallbackCount: fallbackQueue.length,
      });
      return true;
    }

    if (capturedIsPlaylistVideo && capturedVideoId) {
      // Navigate to the video subdirectory within the playlist
      try {
        const pendingRedirect = consumePendingPlaylistRedirect(
          capturedNpub,
          capturedTreeName,
          capturedVideoId,
        );
        if (pendingRedirect?.rootCid) {
          syncResolvedRootCache(pendingRedirect.rootCid);
        }
        const existingPlaylist = get(currentPlaylist);
        const existingPlaylistItem = existingPlaylist
          && existingPlaylist.npub === capturedNpub
          && existingPlaylist.treeName === capturedTreeName
          ? existingPlaylist.items.find((item) => item.id === capturedVideoId)
          : undefined;
        if (pendingRedirect?.videoCid) {
          videoDirCid = pendingRedirect.videoCid;
          videoPathPrefix = `${capturedVideoId}/`;
          logVideoDebug('load:playlist-item-pending', {
            videoId: capturedVideoId,
            cid: toHex(pendingRedirect.videoCid.hash).slice(0, 8),
          });
        } else if (existingPlaylistItem?.cid) {
          videoDirCid = existingPlaylistItem.cid;
          videoPathPrefix = `${capturedVideoId}/`;
          logVideoDebug('load:playlist-item-cached', {
            videoId: capturedVideoId,
            cid: toHex(existingPlaylistItem.cid.hash).slice(0, 8),
          });
        } else {
          const playlistRootCid = pendingRedirect?.rootCid ?? effectiveRootCid ?? rootCidParam;
          const listedPlaylistEntries = await listDirectoryWithTimeout(tree, playlistRootCid);
          if (isStaleLoad('list-playlist-root')) return;
          const listedPlaylistEntry = listedPlaylistEntries?.find((entry) => entry.name === capturedVideoId);
          if (listedPlaylistEntry?.cid) {
            videoDirCid = listedPlaylistEntry.cid;
            videoPathPrefix = `${capturedVideoId}/`;
            logVideoDebug('load:playlist-item-listed', {
              videoId: capturedVideoId,
              cid: toHex(listedPlaylistEntry.cid.hash).slice(0, 8),
            });
          } else {
          // Add timeout to prevent hanging if Blossom is unreachable
            const resolvePromise = tree.resolvePath(playlistRootCid, capturedVideoId);
            const timeoutPromise = new Promise<null>((_, reject) =>
              setTimeout(() => reject(new Error('Timeout: Video data not available from network')), 30000)
            );
            const videoDir = await Promise.race([resolvePromise, timeoutPromise]);
            if (isStaleLoad('resolve-playlist-dir')) return;
            if (videoDir) {
              videoDirCid = videoDir.cid;
              videoPathPrefix = `${capturedVideoId}/`;
            } else {
              const refreshed = await retryWithFreshTreeRoot('missing-playlist-child');
              if (refreshed) return;
              if (isStaleLoad('refresh-missing-playlist-child')) return;
              error = `Video "${capturedVideoId}" not found in playlist`;
              loading = false;
              logVideoDebug('load:missing-playlist', {
                videoId: capturedVideoId,
              });
              return;
            }
          }
        }
      } catch (e) {
        if (isStaleLoad('resolve-playlist-error')) return;
        error = e instanceof Error ? e.message : `Failed to load video: ${e}`;
        loading = false;
        logVideoDebug('load:playlist-error', {
          videoId: capturedVideoId,
          error,
        });
        return;
      }
    }

    async function tryResolveCurrentVideoDir(): Promise<void> {
      if (isStaleLoad('set-video-folder')) return;
      videoFolderCid = videoDirCid;

      // Prefer actual directory contents over guessed filenames to avoid slow sequential misses.
      let videoDirEntries: Awaited<ReturnType<ReturnType<typeof getTree>['listDirectory']>> | null = null;
      try {
        const dir = await listDirectoryWithTimeout(tree, videoDirCid);
        videoDirEntries = dir;
        if (isStaleLoad('list-video-dir')) return;
        logVideoDebug('list:result', {
          treeName: capturedTreeName,
          entryCount: dir?.length ?? 0,
          entries: dir?.slice(0, 12).map((entry) => entry.name) ?? [],
        });
        const videoEntry = dir ? findPlayableMediaEntry(dir) : undefined;

        if (videoEntry) {
          await applyResolvedVideo(videoEntry.cid, videoEntry.name);
        }
      } catch {}

      if (!resolvedVideo) {
        const directMediaFileName = await readDirectPlayableMediaFileName(tree, videoDirCid, VIDEO_RESOLVE_TIMEOUT_MS);
        if (isStaleLoad('probe-direct-root-media')) return;
        if (directMediaFileName) {
          logVideoDebug('resolve:direct-root-media', {
            treeName: capturedTreeName,
            fileName: directMediaFileName,
          });
          await applyResolvedVideo(videoDirCid, directMediaFileName);
        }
      }

      // If directory contents are incomplete or empty, probe canonical media filenames in parallel.
      if (!resolvedVideo && (!videoDirEntries || videoDirEntries.length === 0 || !findPlayableMediaEntry(videoDirEntries))) {
        const candidates = await Promise.all(
          PREFERRED_PLAYABLE_MEDIA_FILENAMES.map(async (name) => ({
            name,
            result: await resolvePathWithTimeout(tree, videoDirCid, name),
          }))
        );
        if (isStaleLoad('resolve-preferred-media')) return;
        logVideoDebug('resolve:preferred-results', {
          treeName: capturedTreeName,
          results: candidates.map((candidate) => ({
            name: candidate.name,
            found: !!candidate.result,
          })),
        });
        const match = candidates.find((candidate) => candidate.result);
        if (match?.result) {
          await applyResolvedVideo(match.result.cid, match.name);
        }
      }
    }

    await tryResolveCurrentVideoDir();
    if (isStaleLoad('initial-root-resolve')) return;

    if (!resolvedVideo && !capturedIsPlaylistVideo && readableRootPromise) {
      const readableRootCid = await readableRootPromise;
      if (isStaleLoad('resolve-readable-root')) return;
      if (readableRootCid && rootCidParam && toHex(readableRootCid.hash) !== toHex(rootCidParam.hash)) {
        effectiveRootCid = readableRootCid;
        videoDirCid = readableRootCid;
        videoPathPrefix = '';
        setRouteRootOverride(capturedRouteRootKey, readableRootCid, 'readable-fallback');
        logVideoDebug('load:root-fallback', {
          npub: capturedNpub,
          treeName: capturedTreeName,
          videoId: capturedVideoId,
          fromHash: toHex(rootCidParam.hash).slice(0, 8),
          toHash: toHex(readableRootCid.hash).slice(0, 8),
        });
        syncResolvedRootCache(readableRootCid);
        await tryResolveCurrentVideoDir();
        if (isStaleLoad('retry-readable-root')) return;
      }
    }

    // If still no video and NOT a playlist video, check if this is a playlist directory root
    if (!resolvedVideo && !capturedIsPlaylistVideo) {
      const { findFirstVideoEntry } = await import('../../stores/playlist');
      const playlistRootCid = effectiveRootCid ?? rootCidParam;
      const firstVideoId = await Promise.race([
        findFirstVideoEntry(playlistRootCid),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), VIDEO_RESOLVE_TIMEOUT_MS)),
      ]);
      if (firstVideoId) {
        const firstVideoDir = await resolvePathWithTimeout(tree, playlistRootCid, firstVideoId);
        rememberPendingPlaylistRedirect({
          npub: capturedNpub,
          treeName: capturedTreeName,
          videoId: firstVideoId,
          rootCid: playlistRootCid,
          videoCid: firstVideoDir?.cid ?? null,
        });
        await loadPlaylist(capturedNpub, capturedTreeName, playlistRootCid, firstVideoId);
        if (isStaleLoad('preload-playlist-before-redirect')) return;
      }
      const playlistUrl = buildPlaylistRedirectHash({
        activeLoadKey: loadedVideoKey,
        expectedLoadKey,
        npub: capturedNpub,
        treeName: capturedTreeName,
        firstVideoId,
      });
      if (playlistUrl) {
        history.replaceState(null, '', playlistUrl);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        return;
      }
      if (isStaleLoad('redirect-first-playlist-video')) return;
    }

    if (!resolvedVideo && !capturedIsPlaylistVideo) {
      const refreshed = await retryWithFreshTreeRoot('unreadable-root');
      if (refreshed) {
        return;
      }
    }

    if (
      !resolvedVideo &&
      !isStaleLoad('mutable-fallback') &&
      startMutableVideoFallback(videoDirCid, capturedNpub, capturedTreeName, videoPathPrefix)
    ) {
      return;
    }

    if (!resolvedVideo) {
      if (isStaleLoad('not-found')) return;
      error = 'Video file not found';
      loading = false;
      logVideoDebug('load:not-found', {
        npub: capturedNpub,
        treeName: capturedTreeName,
        videoId: capturedVideoId,
      });
      return;
    }

    if (isStaleLoad('post-resolve')) return;

    // Add to recents - use full path for playlist videos
    // Compute recentPath first so we can pass it to loadMetadata
    const recentPath = capturedIsPlaylistVideo && capturedVideoId
      ? `/${capturedNpub}/${capturedTreeName}/${capturedVideoId}`
      : `/${capturedNpub}/${capturedTreeName}`;

    addRecent({
      type: 'tree',
      path: recentPath,
      label: getVideoDisplayTitle({
        videoTitle,
        currentVideoId: capturedVideoId,
        videoPath,
        treeName: capturedTreeName,
      }),
      npub: capturedNpub,
      treeName: capturedTreeName,
      videoId: capturedIsPlaylistVideo ? capturedVideoId : undefined,
      visibility: videoVisibility,
    });

    loadMetadata(videoDirCid, tree, recentPath, expectedLoadKey);

    if (capturedIsPlaylistVideo && capturedVideoId) {
      loadPlaylistForVideo(effectiveRootCid ?? rootCidParam, capturedNpub, capturedTreeName, capturedVideoId, expectedLoadKey);
    }
  }

  /** Load playlist from parent directory */
  async function loadPlaylistForVideo(
    playlistRootCid: CID,
    playlistNpub: string,
    playlistTreeName: string,
    videoId: string,
    expectedLoadKey: string,
  ) {
    console.log('[VideoView] Loading playlist for video:', videoId, 'from', playlistTreeName);

    // Load the playlist using the already-resolved root CID (don't resolve again)
    const result = await loadPlaylist(playlistNpub, playlistTreeName, playlistRootCid, videoId);
    if (!isActiveVideoLoad(loadedVideoKey, expectedLoadKey)) return;

    if (result) {
      console.log('[VideoView] Loaded playlist with', result.items.length, 'videos');
    }
  }

  /** Load title and description in background */
  async function loadMetadata(
    rootCid: CID,
    tree: ReturnType<typeof getTree>,
    recentPath?: string,
    expectedLoadKey?: string,
  ) {
    const isStaleMetadataLoad = () =>
      expectedLoadKey ? !isActiveVideoLoad(loadedVideoKey, expectedLoadKey) : false;

    const readTextViaStablePath = async (
      path: string,
      sanitize: (value: unknown) => string,
    ): Promise<string | null> => {
      const url = getStablePathUrl({ rootCid, path });
      if (!url) return null;
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/')) {
          return null;
        }
        const text = sanitize(await response.text());
        return text || null;
      } catch {
        return null;
      }
    };

    try {
      const metadata = await readVideoDirectoryMetadata(tree, rootCid);
      if (isStaleMetadataLoad()) return;
      if (metadata.thumbnailEntry) {
        videoThumbnailUrl = getNhashFileUrl(metadata.thumbnailEntry.cid, metadata.thumbnailEntry.name);
      }
      if (metadata.title) {
        videoTitle = metadata.title;
        if (recentPath) updateRecentLabel(recentPath, videoTitle);
      }
      if (metadata.description) {
        videoDescription = metadata.description;
      }
      if (!videoCreatedAt && metadata.createdAt) {
        videoCreatedAt = metadata.createdAt;
      }
    } catch {}

    if (!videoTitle) {
      const remoteTitle = await readTextViaStablePath('title.txt', sanitizeVideoTitle);
      if (isStaleMetadataLoad()) return;
      if (remoteTitle) {
        videoTitle = remoteTitle;
        if (recentPath) updateRecentLabel(recentPath, videoTitle);
      }
    }

    if (!videoDescription) {
      const remoteDescription = await readTextViaStablePath('description.txt', sanitizeVideoDescription);
      if (isStaleMetadataLoad()) return;
      if (remoteDescription) {
        videoDescription = remoteDescription;
      }
    }
  }

  function handlePermalink() {
    if (snapshotPermalinkHref) {
      window.location.hash = snapshotPermalinkHref.slice(1);
      return;
    }
    if (!videoNhash) return;
    window.location.hash = `#/${videoNhash}`;
  }

  function handleDownload() {
    if (!videoCid || !videoFileName) return;
    // Navigate to SW URL with ?download=1 query param
    // SW will serve with Content-Disposition: attachment header for streaming download
    const baseUrl = getNhashFileUrl(videoCid, videoFileName);
    const separator = baseUrl.includes('?') ? '&' : '?';
    window.location.href = `${baseUrl}${separator}download=1`;
  }

  function handleBlossomPush() {
    if (!rootCid) return;
    const pubkey = npub ? npubToPubkey(npub) : undefined;
    openBlossomPushModal(rootCid, title, true, pubkey, treeName);
  }

  function handleSaveToPlaylist() {
    // Use videoFolderCid which is the video folder (contains video.mp4, title.txt, etc.)
    // For single videos: videoFolderCid = rootCid (the video tree root)
    // For playlist videos: videoFolderCid = the specific video subfolder
    const cidToSave = videoFolderCid || rootCid;
    if (!cidToSave) return;
    // Estimate size (we don't have exact size, but it's not critical)
    openAddToPlaylistModal({ videoCid: cidToSave, videoTitle: title, videoSize: 0 });
  }

  async function handleDelete() {
    if (!treeName || deleting) return;
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;

    deleting = true;
    try {
      if (isPlaylistVideo && currentVideoId && rootCid) {
        // Delete only this video from the playlist (not the whole playlist)
        await deletePlaylistVideo();
      } else {
        // Delete the entire tree (single video)
        if (npub && treeName) {
          recordDeletedVideo(npub, treeName, Math.floor(Date.now() / 1000) + 1);
          removeRecentByTreeName(npub, treeName);
        }
        await deleteTree(treeName);
        window.location.hash = '#/';
      }
    } catch (e) {
      console.error('Failed to delete video:', e);
      alert('Failed to delete video');
      deleting = false;
    }
  }

  /**
   * Delete a single video from a playlist without removing the whole playlist
   */
  async function deletePlaylistVideo() {
    if (!npub || !treeName || !currentVideoId || !rootCid) return;

    const tree = getTree();

    // Get the current playlist root CID (the parent directory)
    const { getLocalRootCache, getLocalRootKey } = await import('../../treeRootCache');
    const playlistRootHash = getLocalRootCache(npub, treeName);
    if (!playlistRootHash) {
      throw new Error('Playlist root not found');
    }

    const playlistRootKey = getLocalRootKey(npub, treeName);
    const playlistCid = playlistRootKey
      ? { hash: playlistRootHash, key: playlistRootKey }
      : { hash: playlistRootHash };

    // Remove the video entry from the playlist
    const newPlaylistCid = await tree.removeEntry(playlistCid, [], currentVideoId);

    // Check how many videos remain (directories containing videos)
    const remainingEntries = await tree.listDirectory(newPlaylistCid);
    // Filter for directories - type can be LinkType.Dir (2) or check by inspecting contents
    const remainingVideos: typeof remainingEntries = [];
    for (const entry of remainingEntries) {
      try {
        // Try to list as directory - if it works, it's a directory
        const subEntries = await tree.listDirectory(entry.cid);
        const hasVideo = subEntries?.some(e =>
          e.name.startsWith('video.') ||
          e.name.endsWith('.mp4') ||
          e.name.endsWith('.webm') ||
          e.name.endsWith('.mkv')
        );
        if (hasVideo) {
          remainingVideos.push(entry);
        }
      } catch {
        // Not a directory, skip
      }
    }

    if (remainingVideos.length === 0) {
      // No videos left - delete the whole playlist
      if (npub && treeName) {
        recordDeletedVideo(npub, treeName, Math.floor(Date.now() / 1000) + 1);
        removeRecentByTreeName(npub, treeName);
      }
      await deleteTree(treeName);
      window.location.hash = '#/';
    } else {
      // Update the playlist root with the new CID
      updateLocalRootCacheHex(
        npub,
        treeName,
        toHex(newPlaylistCid.hash),
        newPlaylistCid.key ? toHex(newPlaylistCid.key) : undefined,
        videoVisibility
      );

      // Clear the current playlist from store to force reload
      const { clearPlaylist } = await import('../../stores/playlist');
      clearPlaylist();

      // Navigate to the next video in the playlist
      const nextVideoId = remainingVideos[0].name;
      window.location.hash = `#/${npub}/${encodeURIComponent(treeName)}/${encodeURIComponent(nextVideoId)}`;
    }
  }

  function startEdit() {
    editTitle = videoTitle || videoName || '';
    editDescription = videoDescription || '';
    editing = true;
  }

  function cancelEdit() {
    editing = false;
    editTitle = '';
    editDescription = '';
  }

  async function saveEdit() {
    if (!npub || !treeName || saving) return;
    if (!editTitle.trim()) {
      alert('Title is required');
      return;
    }

    saving = true;
    try {
      let currentRootCid = rootCid;
      if (!currentRootCid) throw new Error('Video not found');

      const tree = getTree();

      // Find video file entry
      const entries = await tree.listDirectory(currentRootCid);
      const videoEntry = entries ? findPlayableMediaEntry(entries) : undefined;
      if (!videoEntry) throw new Error('Video file not found');

      // Get existing metadata from link entry or legacy metadata.json
      let existingMeta: Record<string, unknown> = { ...(videoEntry.meta || {}) };

      // If no createdAt in link meta, try to get it from metadata.json
      if (!existingMeta.createdAt) {
        try {
          const metadataResult = await tree.resolvePath(currentRootCid, 'metadata.json');
          if (metadataResult) {
            const metadataData = await tree.readFile(metadataResult.cid);
            if (metadataData) {
              const legacyMeta = JSON.parse(new TextDecoder().decode(metadataData));
              if (legacyMeta.createdAt) existingMeta.createdAt = legacyMeta.createdAt;
              if (legacyMeta.originalDate) existingMeta.originalDate = legacyMeta.originalDate;
              if (legacyMeta.duration) existingMeta.duration = legacyMeta.duration;
            }
          }
        } catch {}
      }

      // Update title/description
      existingMeta.title = editTitle.trim();
      if (editDescription.trim()) {
        existingMeta.description = editDescription.trim();
      } else {
        delete existingMeta.description;
      }

      // Set createdAt if still missing
      if (!existingMeta.createdAt) {
        existingMeta.createdAt = Math.floor(Date.now() / 1000);
      }

      // Update video entry with new metadata
      currentRootCid = await tree.setEntry(
        currentRootCid,
        [],
        videoEntry.name,
        videoEntry.cid,
        videoEntry.size,
        videoEntry.type,
        existingMeta
      );

      // Clean up legacy metadata files
      try { currentRootCid = await tree.removeEntry(currentRootCid, [], 'metadata.json'); } catch {}
      try { currentRootCid = await tree.removeEntry(currentRootCid, [], 'title.txt'); } catch {}
      try { currentRootCid = await tree.removeEntry(currentRootCid, [], 'description.txt'); } catch {}

      // Save and publish
      updateLocalRootCacheHex(
        npub,
        treeName,
        toHex(currentRootCid.hash),
        currentRootCid.key ? toHex(currentRootCid.key) : undefined,
        videoVisibility
      );

      // Update local state
      videoTitle = editTitle.trim();
      videoDescription = editDescription.trim();
      editing = false;
    } catch (e) {
      console.error('Failed to save:', e);
      alert('Failed to save changes');
    } finally {
      saving = false;
    }
  }


  // Video identifier for reactions (npub/treeName format - path to video directory)
  // For playlist videos, include the videoId to target the specific video, not the whole playlist
  let videoIdentifier = $derived.by(() => {
    if (!npub || !treeName) return null;
    // For playlist videos, include the video folder ID in the identifier
    if (isPlaylistVideo && currentVideoId) {
      return `${npub}/${treeName}/${currentVideoId}`;
    }
    return `${npub}/${treeName}`;
  });

  let currentRecentPath = $derived.by(() => {
    if (!npub || !treeName) return null;
    return isPlaylistVideo && currentVideoId
      ? `/${npub}/${treeName}/${currentVideoId}`
      : `/${npub}/${treeName}`;
  });

  $effect(() => {
    const recentPath = currentRecentPath;
    const mediaRootCid = videoFolderCid || rootCid;
    const resolvedVideoPath = videoFileName;
    const resolvedThumbnailUrl = videoThumbnailUrl;
    if (!recentPath) return;
    if (!mediaRootCid && !resolvedVideoPath && !resolvedThumbnailUrl) return;

    setRecentVideoCardInfo(recentPath, {
      videoCount: 0,
      rootCid: mediaRootCid ?? null,
      videoPath: resolvedVideoPath || undefined,
      thumbnailUrl: resolvedThumbnailUrl || undefined,
      duration: Number.isFinite(videoRef?.duration) ? Math.round(videoRef.duration) : undefined,
      title: videoTitle || undefined,
    });
  });

  // Subscribe to likes for this video
  $effect(() => {
    const identifier = videoIdentifier;
    const currentUserPubkey = userPubkey; // Capture for callback
    if (!identifier) return;

    // Reset state
    untrack(() => {
      likes.clear();
      userLiked = false;
    });

    // Subscribe to kind 17 reactions with our identifier
    const filter: NDKFilter = {
      kinds: [17 as number],
      '#i': [identifier],
    };

    const sub = ndk.subscribe(filter, { closeOnEose: false });

    sub.on('event', (event: NDKEvent) => {
      if (!event.pubkey) return;

      // Check if it's a like (+ or empty content)
      const content = event.content?.trim() || '+';
      if (content === '+' || content === '') {
        untrack(() => {
          likes.add(event.pubkey);

          // Check if current user liked
          if (event.pubkey === currentUserPubkey) {
            userLiked = true;
          }
        });
      }
    });

    return () => {
      sub.stop();
    };
  });

  // Subscribe to comment count for mobile toggle
  $effect(() => {
    const identifier = videoIdentifier;
    if (!identifier) return;

    untrack(() => {
      commentCount = 0;
    });

    const seenIds = new SvelteSet<string>();
    const filter: NDKFilter = {
      kinds: [1111 as number],
      '#i': [identifier],
    };

    const sub = ndk.subscribe(filter, { closeOnEose: false });

    sub.on('event', (event: NDKEvent) => {
      if (!event.id || seenIds.has(event.id)) return;
      seenIds.add(event.id);
      untrack(() => {
        commentCount = seenIds.size;
      });
    });

    return () => {
      sub.stop();
    };
  });

  // Extract dominant color from thumbnail
  $effect(() => {
    const currentNpub = npub;
    const currentTreeName = treeName;
    const videoId = currentVideoId;
    void htreePrefixVersion;
    if (!currentNpub || !currentTreeName) return;

    // Reset color for new video
    untrack(() => {
      thumbnailColor = null;
    });

    const thumbUrl = getStableThumbnailUrl({
      thumbnailUrl: videoThumbnailUrl,
      rootCid,
      npub: currentNpub,
      treeName: currentTreeName,
      videoId: videoId || undefined,
      allowAliasFallback: false,
    });
    if (!thumbUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      // Extract color using canvas
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      const w = 32;
      const h = 18;
      canvas.width = w;
      canvas.height = h;

      try {
        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;

        let r = 0, g = 0, b = 0, count = 0;

        for (let i = 0; i < data.length; i += 16) {
          const pr = data[i];
          const pg = data[i + 1];
          const pb = data[i + 2];

          const max = Math.max(pr, pg, pb);
          const min = Math.min(pr, pg, pb);
          const lightness = (max + min) / 2;

          if (lightness > 20 && lightness < 235) {
            const saturation = max === 0 ? 0 : (max - min) / max;
            const weight = 1 + saturation * 2;

            r += pr * weight;
            g += pg * weight;
            b += pb * weight;
            count += weight;
          }
        }

        if (count > 0) {
          thumbnailColor = {
            r: Math.round(r / count),
            g: Math.round(g / count),
            b: Math.round(b / count)
          };
        }
      } catch {
        // CORS or other error
      }
    };

    img.src = thumbUrl;
  });

  // Toggle like
  async function toggleLike() {
    if (!videoIdentifier || !isLoggedIn || liking) return;

    liking = true;
    try {
      const event = new NDKEvent(ndk);
      event.kind = 17; // External content reaction
      event.content = userLiked ? '' : '+'; // Toggle (note: can't really "unlike" in Nostr, but we track locally)

      // Build tags - include both npub path and nhash for discoverability
      const tags: string[][] = [
        ['i', videoIdentifier],
        ['k', 'video'],
      ];

      // Add nhash identifier for permalink reactions (uses video file CID, not directory)
      // Plain nhash is sufficient since it points directly to the file content
      if (videoNhash) {
        tags.push(['i', videoNhash]);
      }

      // Add p tag if we know the owner
      if (ownerPubkey) {
        tags.push(['p', ownerPubkey]);
      }

      event.tags = tags;

      await event.sign();
      await event.publish();

      // Update local state optimistically
      if (!userLiked) {
        likes.add(userPubkey!);
        userLiked = true;
      }
    } catch (e) {
      console.error('Failed to like video:', e);
    } finally {
      liking = false;
    }
  }

  // Ambient glow around video
  let ambient = $derived($ambientColor);
  let glowStyle = $derived.by(() => {
    if (!ambient) return '';
    const { r, g, b } = ambient;
    return `rgb(${r}, ${g}, ${b})`;
  });

  // Transform thumbnail color: boost saturation and brighten
  function getHighlightColor(color: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
    let { r, g, b } = color;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > min) {
      const avg = (r + g + b) / 3;
      const boost = 2.0;
      r = Math.round(avg + (r - avg) * boost);
      g = Math.round(avg + (g - avg) * boost);
      b = Math.round(avg + (b - avg) * boost);
    }
    const brighten = 1.3;
    return {
      r: Math.min(255, Math.max(0, Math.round(r * brighten))),
      g: Math.min(255, Math.max(0, Math.round(g * brighten))),
      b: Math.min(255, Math.max(0, Math.round(b * brighten)))
    };
  }

  // Highlight color derived from thumbnail
  let highlightRgba = $derived.by(() => {
    if (!thumbnailColor) return null;
    const { r, g, b } = getHighlightColor(thumbnailColor);
    return `rgba(${r}, ${g}, ${b}, 0.2)`;
  });

  // Description box hover color
  let descriptionHoverStyle = $derived(highlightRgba ? `--desc-hover-color: ${highlightRgba};` : '');

  // Playlist active item background style
  let playlistActiveStyle = $derived(highlightRgba ? `background-color: ${highlightRgba};` : '');

  // Track video container position for glow
  let videoContainer: HTMLDivElement | undefined = $state();
  let glowRect = $state({ top: 0, left: 0, width: 0, height: 0 });

  $effect(() => {
    if (!videoContainer) return;

    function updateRect() {
      if (!videoContainer) return;
      const rect = videoContainer.getBoundingClientRect();
      glowRect = {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      };
    }

    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);

    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  });
</script>

{#snippet ownerMeta()}
  <div class="text-sm text-text-3">
    {knownFollowers.size} known follower{knownFollowers.size !== 1 ? 's' : ''}
  </div>
{/snippet}

{#snippet ownerActions()}
  <FollowButton pubkey={ownerPubkey} />
  {#if videoIdentifier}
    <VideoZapButton {videoIdentifier} {ownerPubkey} />
  {/if}
{/snippet}

{#snippet pageActions()}
  <button onclick={toggleTheaterMode} class="btn-ghost p-2 {theaterMode ? '' : 'hidden lg:block'}" title={theaterMode ? 'Exit theater mode' : 'Theater mode'}>
    <span class={theaterMode ? 'i-lucide-columns-2' : 'i-lucide-rectangle-horizontal'} class:text-lg={true}></span>
  </button>
  {#if videoIdentifier}
    <button
      onclick={toggleLike}
      class="btn-ghost p-2 flex items-center gap-1"
      class:text-accent={userLiked}
      title={userLiked ? 'Liked' : 'Like'}
      disabled={!isLoggedIn || liking}
    >
      <span class={userLiked ? 'i-lucide-heart text-lg' : 'i-lucide-heart text-lg'} class:fill-current={userLiked}></span>
      {#if likes.size > 0}
        <span class="text-sm">{likes.size}</span>
      {/if}
    </button>
  {/if}
  {#if isLoggedIn}
    <button
      onclick={handleSaveToPlaylist}
      class="btn-ghost p-2"
      title="Add to playlist"
      disabled={!rootCid || !!protectedVideoState}
    >
      <span class="i-lucide-bookmark text-lg"></span>
    </button>
  {/if}
  <ShareButton url={window.location.href} />
  <button onclick={handlePermalink} class="btn-ghost p-2" title="Permalink" disabled={!snapshotPermalinkHref && !videoNhash}>
    <span class="i-lucide-link text-lg"></span>
  </button>
  <button onclick={handleDownload} class="btn-ghost p-2" title="Download" disabled={!videoCid}>
    <span class="i-lucide-download text-lg"></span>
  </button>
  {#if isOwner}
    <button onclick={handleBlossomPush} class="btn-ghost p-2" title="Push to file servers">
      <span class="i-lucide-upload-cloud text-lg"></span>
    </button>
    <button onclick={startEdit} class="btn-ghost p-2" title="Edit">
      <span class="i-lucide-pencil text-lg"></span>
    </button>
    <button
      onclick={handleDelete}
      class="btn-ghost p-2 text-red-400 hover:text-red-300"
      title="Delete video"
      disabled={deleting}
    >
      <span class={deleting ? 'i-lucide-loader-2 animate-spin' : 'i-lucide-trash-2'} class:text-lg={true}></span>
    </button>
  {/if}
{/snippet}

<AmbientGlow {videoRef} />

{#snippet videoContent()}
  <!-- Video Info -->
  <div class="mb-6">
    {#if editing}
      <!-- Edit form -->
      <div class="space-y-4">
        <div>
          <label for="video-edit-title" class="block text-sm text-text-2 mb-1">Title</label>
          <input
            id="video-edit-title"
            type="text"
            bind:value={editTitle}
            class="w-full bg-surface-0 border border-surface-3 rounded-lg p-3 text-text-1 focus:border-accent focus:outline-none"
            placeholder="Video title"
            disabled={saving}
          />
        </div>
        <div>
          <label for="video-edit-description" class="block text-sm text-text-2 mb-1">Description</label>
          <textarea
            id="video-edit-description"
            bind:value={editDescription}
            class="textarea w-full resize-none"
            placeholder="Video description..."
            rows="3"
            disabled={saving}
          ></textarea>
        </div>
        <div class="flex gap-2">
          <button onclick={saveEdit} class="btn-primary px-4 py-2" disabled={saving || !editTitle.trim()}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button onclick={cancelEdit} class="btn-ghost px-4 py-2" disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    {:else}
      <VideoDetails
        title={title}
        visibility={effectiveVisibility}
        ownerHref={npub ? `#/${npub}` : null}
        ownerPubkey={ownerPubkey}
        {ownerMeta}
        {ownerActions}
        {pageActions}
        description={videoDescription || ''}
        descriptionMaxLines={4}
        descriptionMaxChars={400}
        descriptionClass="bg-surface-1 text-text-1 text-sm"
        descriptionStyle={descriptionHoverStyle}
        descriptionTimestamp={videoCreatedAt ? formatTimeAgo(videoCreatedAt) : undefined}
      />
    {/if}
  </div>

  <!-- Comments (toggleable on mobile, always visible on desktop) -->
  {#if npub && treeName}
    <!-- Mobile toggle header -->
    <button
      class="lg:hidden w-full flex items-center justify-between py-3 border-t border-surface-3 text-text-1"
      onclick={() => mobileCommentsOpen = !mobileCommentsOpen}
    >
      <span class="text-lg font-semibold">Comments ({commentCount})</span>
      <span class={mobileCommentsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'} class:text-xl={true}></span>
    </button>
    <!-- Desktop: always show, Mobile: toggle -->
    <div class={mobileCommentsOpen ? '' : 'hidden lg:block'}>
      {#key `${npub}/${treeName}/${currentVideoId || ''}`}
        <VideoComments {npub} {treeName} nhash={videoNhash} filename={videoFileName} />
      {/key}
    </div>
  {/if}
{/snippet}

{#snippet sidebar()}
  {#if playlist && showPlaylistSidebar && playlist.items.length > 1}
    <div class="h-[600px] overflow-y-auto border border-text-3 rounded-lg mb-4">
      <PlaylistSidebar activeStyle={playlistActiveStyle} />
    </div>
  {/if}
  <FeedSidebar currentHref={`#/${npub}/${treeName ? encodeURIComponent(treeName) : ''}`} />
{/snippet}

<!--
  Layout uses CSS-only approach around the player container.
  The video element itself is keyed by source so WebKit gets a clean media element
  when navigating between clips.
  Theater mode: video full width, content+sidebar row below (max-w-6xl)
  Non-theater: constrained container (max-w-7xl), sidebar beside video+content
-->
<div class="flex-1 overflow-y-auto pb-4">
  <div class="{theaterMode ? '' : 'flex max-w-7xl mx-auto'}">
    <!-- Main column: video + content -->
    <div class="flex-1 min-w-0 {theaterMode ? '' : 'lg:px-4 lg:pt-3'}">
      <!-- Video Player (never remounts) -->
      <div class="relative">
        <div
          class="fixed pointer-events-none"
          style="
            top: {glowRect.top - 40}px;
            left: {glowRect.left - 40}px;
            width: {glowRect.width + 80}px;
            height: {glowRect.height + 80}px;
            background-color: {glowStyle || 'transparent'};
            filter: blur(60px);
            opacity: 0.25;
            transition: background-color 5s ease-out;
            z-index: 0;
          "
        ></div>
        <div
          bind:this={videoContainer}
          class="w-full mx-auto aspect-video max-h-[calc(100vh-180px)] relative z-10 {theaterMode ? '' : 'lg:rounded-xl lg:overflow-hidden'}"
          data-video-src={videoSrc}
          data-video-filename={videoFileName}
          data-htree-prefix={htreePrefix}
          data-video-load-runs={loadEffectRuns}
          data-video-key={loadedVideoKey ?? ''}
          data-video-root-hash={effectiveRouteRootCid ? toHex(effectiveRouteRootCid.hash).slice(0, 16) : ''}
          data-video-npub={npub ?? ''}
          data-video-tree-name={treeName ?? ''}
        >
          {#if protectedVideoState}
            <div class="w-full h-full flex items-center justify-center p-8" data-testid="video-protected">
              <div class="text-center">
                <div class="inline-flex items-center justify-center mb-4">
                  {#if protectedVideoState.visibility === 'link-visible'}
                    {#if protectedVideoState.hasLinkKey}
                      <span class="i-lucide-key-round text-3xl text-danger"></span>
                    {:else}
                      <span class="relative inline-block shrink-0 text-3xl text-text-3">
                        <span class="i-lucide-link"></span>
                        <span class="i-lucide-lock absolute -bottom-0.5 -right-1.5 text-[0.6em]"></span>
                      </span>
                    {/if}
                  {:else}
                    <span class="i-lucide-lock text-3xl text-text-3"></span>
                  {/if}
                </div>
                <div class="text-text-2 font-medium mb-2">{protectedVideoState.title}</div>
                <div class="text-text-3 text-sm max-w-xs mx-auto">{protectedVideoState.description}</div>
              </div>
            </div>
          {:else if error}
            <div class="w-full h-full flex items-center justify-center text-red-400">
              <span class="i-lucide-alert-circle mr-2"></span>
              {error}
            </div>
          {:else if videoSrc}
            {#key videoElementKey}
              {#if isAudioOnly}
                <div class="w-full h-full flex flex-col items-center justify-center gap-6 bg-surface-2 px-6">
                  <span class="i-lucide-audio-lines text-7xl text-text-3"></span>
                  <audio
                    bind:this={videoRef}
                    use:applyVolumeSettings
                    src={videoSrc}
                    controls
                    autoplay
                    muted={initialVideoSettings.muted}
                    class="w-full max-w-2xl"
                    preload="metadata"
                    onloadedmetadata={handleLoadedMetadata}
                    ontimeupdate={handleTimeUpdate}
                    onvolumechange={handleVolumeChange}
                    onerror={handleVideoError}
                    onended={handleEnded}
                  >
                    Your browser does not support the audio tag.
                  </audio>
                </div>
              {:else}
                <video
                  bind:this={videoRef}
                  use:applyVolumeSettings
                  src={videoSrc}
                  controls
                  autoplay
                  playsinline
                  muted={initialVideoSettings.muted}
                  class="w-full h-full"
                  preload="metadata"
                  onloadedmetadata={handleLoadedMetadata}
                  ontimeupdate={handleTimeUpdate}
                  onvolumechange={handleVolumeChange}
                  onerror={handleVideoError}
                  onended={handleEnded}
                >
                  Your browser does not support the video tag.
                </video>
              {/if}
            {/key}
          {/if}
        </div>
      </div>

      <!-- Content below video wrapper - changes based on theater mode -->
      <div class="{theaterMode ? 'flex max-w-6xl mx-auto' : ''}">
        <div class="flex-1 min-w-0 px-4 py-4">
          {@render videoContent()}
        </div>
        <!-- Desktop sidebar (theater mode: beside content) -->
        {#if theaterMode}
          <div class="w-96 shrink-0 hidden lg:block overflow-y-auto pt-4">
            {@render sidebar()}
          </div>
        {/if}
      </div>
    </div>

    <!-- Desktop sidebar (non-theater: beside everything including video) -->
    {#if !theaterMode}
      <div class="w-96 shrink-0 hidden lg:block overflow-y-auto py-3">
        {@render sidebar()}
      </div>
    {/if}
  </div>

  <!-- Mobile sidebar (always below content) - show both playlist and feed -->
  <div class="lg:hidden pb-4">
    {#if playlist && showPlaylistSidebar && playlist.items.length > 1}
      <div class="h-[600px] overflow-y-auto border border-text-3 rounded-lg mb-4">
        <PlaylistSidebar activeStyle={playlistActiveStyle} />
      </div>
    {/if}
    <FeedSidebar currentHref={`#/${npub}/${treeName ? encodeURIComponent(treeName) : ''}`} />
  </div>
</div>
