<script lang="ts">
  /**
   * VideoHome - Home page for video.iris.to
   * YouTube-style home with horizontal sections and infinite feed
   */
  import { onMount, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { nip19 } from 'nostr-tools';
  import type { NDKEvent } from 'ndk';
  import { ndk, nostrStore } from '../../nostr';
  import { getWorkerAdapter, waitForWorkerAdapter } from '../../lib/workerInit';
  import type { CID } from '@hashtree/core';
  import { recentsStore, clearRecentsByPrefix, type RecentItem } from '../../stores/recents';
  import { createFollowsStore } from '../../stores';
  import {
    detectPlaylistForCard,
    detectVideoCardInfo,
    getCachedPlaylistInfo,
    shouldRefreshPlaylistCardInfo,
  } from '../../stores/playlist';
  import { indexVideo } from '../../stores/searchIndex';
  import { getTreeRootSync, updateSubscriptionCache, waitForTreeRoot } from '../../stores/treeRoot';
  import {
    videosByKey,
    socialVideosByKey,
    socialSeenEventIds,
    clearCacheIfUserChanged,
    getCachedVideos,
    getCachedSocialVideos,
    getFeedPlaylistInfo,
    setFeedPlaylistInfo,
    clearFeedPlaylistInfo,
    getAllFeedPlaylistInfo,
    getRecentVideoCardInfo,
    recentVideoCardInfoVersion,
    setRecentVideoCardInfo,
    type PlaylistInfo,
    type RecentVideoCardInfo,
  } from '../../stores/homeFeedCache';
  import { fromHex, nhashEncode, toHex } from '@hashtree/core';
  import InfiniteScroll from '../InfiniteScroll.svelte';
  import { DEFAULT_BOOTSTRAP_PUBKEY, DEFAULT_VIDEO_FEED_PUBKEYS } from '../../utils/constants';
  import { orderFeedWithInterleaving } from '../../utils/feedOrder';
  import { feedStore, setFeedVideos } from '../../stores/feedStore';
  import { recordDeletedVideo, getDeletedVideoTimestamp, clearDeletedVideo } from '../../stores/videoDeletes';
  import { resolveFeedVideoRootCid, resolveFeedVideoRootCidAsync } from '../../lib/videoFeedRoot';
  import { getStableThumbnailUrl } from '../../lib/mediaUrl';
  import { onCacheUpdate } from '../../treeRootCache';
  import { resolveReadableThumbnailRoot, resolveReadableVideoRoot } from '../../lib/readableVideoRoot';
  import {
    buildPreferredTreeEventHref,
    buildTreeEventPermalink,
    buildTreeRouteHref,
    cacheTreeEventSnapshotFromNdkEvent,
  } from '../../lib/treeEventSnapshots';

  const MIN_FOLLOWS_THRESHOLD = 5;
  import VideoCard from './VideoCard.svelte';
  import PlaylistCard from './PlaylistCard.svelte';
  import type { VideoItem } from './types';

  let workerReady = $state(!!getWorkerAdapter());

  onMount(() => {
    let active = true;
    if (!workerReady) {
      waitForWorkerAdapter(10000).then((adapter) => {
        if (!active) return;
        if (!adapter) {
          console.warn('[VideoHome] Worker not ready - subscribing anyway');
        }
        workerReady = true;
      });
    }
    return () => {
      active = false;
    };
  });

  /** Encode tree name for use in URL path */
  function encodeTreeNameForUrl(treeName: string): string {
    return encodeURIComponent(treeName);
  }

  async function buildIndexedVideoHref(
    ownerNpub: string,
    treeName: string,
    options: { path?: string[]; snapshotEvent?: NDKEvent } = {},
  ): Promise<string> {
    const fallbackHref = buildTreeRouteHref(ownerNpub, treeName, options.path);
    if (options.snapshotEvent) {
      const snapshot = await cacheTreeEventSnapshotFromNdkEvent(options.snapshotEvent).catch(() => null);
      if (snapshot) {
        return buildTreeEventPermalink(snapshot, options.path);
      }
    }
    return buildPreferredTreeEventHref(ownerNpub, treeName, options.path).catch(() => fallbackHref);
  }

  function sameCid(a: CID | null | undefined, b: CID | null | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return toHex(a.hash) === toHex(b.hash)
      && ((a.key && b.key && toHex(a.key) === toHex(b.key)) || (!a.key && !b.key));
  }

  function getRootHashHex(rootCid: CID | null | undefined): string | null {
    return rootCid?.hash ? toHex(rootCid.hash) : null;
  }

  function shouldSkipFeedEvent(existing: VideoItem | undefined, eventTimestamp: number): boolean {
    if (!existing?.timestamp) return false;
    if (existing.timestamp > eventTimestamp) return true;
    if (existing.timestamp < eventTimestamp) return false;
    return !!existing.rootCid?.hash;
  }

  function removeVideoFromCaches(ownerNpub: string, treeName: string, eventTimestamp: number) {
    const key = `${ownerNpub}/${treeName}`;
    const existing = videosByKey.get(key);
    if (existing && (existing.timestamp || 0) > eventTimestamp) {
      return;
    }
    const removed = videosByKey.delete(key);
    const removedSocial = socialVideosByKey.delete(key);
    if (feedPlaylistInfo[key] !== undefined) {
      clearFeedPlaylistInfo(key);
      const next = { ...feedPlaylistInfo };
      delete next[key];
      feedPlaylistInfo = next;
    }
    if (removedSocial) {
      socialVideos = socialVideosByKey.values();
    }
    return removed || removedSocial;
  }

  // Get current user
  let userPubkey = $derived($nostrStore.pubkey);
  let isLoggedIn = $derived($nostrStore.isLoggedIn);

  // Track loading state for follows
  let followsLoading = $state(true);

  // Delay showing "no videos" to avoid flash during initial load
  let showEmptyState = $state(false);
  let emptyStateTimer: ReturnType<typeof setTimeout> | null = null;

  // Get recents and filter to only videos, deduped by normalized href
  let recents = $derived($recentsStore);
  let recentVideos = $derived(
    recents
      .filter(r => r.treeName?.startsWith('videos/') && !(r.npub && r.treeName && getDeletedVideoTimestamp(r.npub, r.treeName)))
      .map(r => ({
        key: r.path,
        // For playlist videos (with videoId), use label; otherwise extract from treeName
        title: r.videoId ? r.label : (r.treeName ? r.treeName.slice(7) : r.label),
        ownerPubkey: r.npub ? npubToPubkey(r.npub) : null,
        ownerNpub: r.npub,
        treeName: r.treeName,
        videoId: r.videoId,
        visibility: r.visibility,
        href: buildRecentHref(r),
        timestamp: r.timestamp,
        duration: r.duration,
      } as VideoItem))
      .filter((v, i, arr) => arr.findIndex(x => x.href === v.href) === i)
      .slice(0, 10)
  );
  let recentCardInfoByKey = $state<Record<string, RecentVideoCardInfo>>({});
  let resolvedRecentCardInfoByKey = $derived.by(() => {
    void $recentVideoCardInfoVersion;
    const next: Record<string, RecentVideoCardInfo> = {};
    for (const video of recentVideos) {
      const cached = getRecentVideoCardInfo(video.key);
      const detected = recentCardInfoByKey[video.key];
      if (cached || detected) {
        next[video.key] = {
          ...(cached ?? { videoCount: 0 }),
          ...(detected ?? {}),
        };
      }
    }
    return next;
  });

  // Playlist detection for feed videos - initialize from persistent cache
  let feedPlaylistInfo = $state<Record<string, PlaylistInfo>>(getAllFeedPlaylistInfo());

  // Debounce playlist detection to avoid excessive calls
  let detectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingVideos: VideoItem[] = [];
  let recentDetectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRecentVideos: VideoItem[] = [];
  const playlistRetryTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();
  const playlistRetryCounts = new SvelteMap<string, number>();
  const recentRetryTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();
  const recentRetryCounts = new SvelteMap<string, number>();
  const MAX_PLAYLIST_DETECTION_RETRIES = 6;
  const MAX_RECENT_MEDIA_RETRIES = 6;

  function clearPlaylistRetry(videoKey: string) {
    const timer = playlistRetryTimers.get(videoKey);
    if (timer) {
      clearTimeout(timer);
      playlistRetryTimers.delete(videoKey);
    }
    playlistRetryCounts.delete(videoKey);
  }

  function schedulePlaylistRetry(video: VideoItem) {
    if (playlistRetryTimers.has(video.key)) return;
    const nextAttempt = (playlistRetryCounts.get(video.key) ?? 0) + 1;
    if (nextAttempt > MAX_PLAYLIST_DETECTION_RETRIES) return;
    playlistRetryCounts.set(video.key, nextAttempt);
    const delayMs = 250 * (2 ** (nextAttempt - 1));
    const timer = setTimeout(() => {
      playlistRetryTimers.delete(video.key);
      void doDetectPlaylists([video]);
    }, delayMs);
    playlistRetryTimers.set(video.key, timer);
  }

  function clearRecentRetry(videoKey: string) {
    const timer = recentRetryTimers.get(videoKey);
    if (timer) {
      clearTimeout(timer);
      recentRetryTimers.delete(videoKey);
    }
    recentRetryCounts.delete(videoKey);
  }

  function scheduleRecentRetry(video: VideoItem) {
    if (recentRetryTimers.has(video.key)) return;
    const nextAttempt = (recentRetryCounts.get(video.key) ?? 0) + 1;
    if (nextAttempt > MAX_RECENT_MEDIA_RETRIES) return;
    recentRetryCounts.set(video.key, nextAttempt);
    const delayMs = 250 * (2 ** (nextAttempt - 1));
    const timer = setTimeout(() => {
      recentRetryTimers.delete(video.key);
      void doDetectRecentMedia([video]);
    }, delayMs);
    recentRetryTimers.set(video.key, timer);
  }

  onMount(() => {
    const unsubscribe = onCacheUpdate((npub, treeName) => {
      const pending = untrack(() => feedVideos.filter((video) =>
        video.ownerNpub === npub
        && video.treeName === treeName
        && !feedPlaylistInfo[video.key]?.thumbnailUrl
      ));
      if (pending.length > 0) {
        void doDetectPlaylists(pending);
      }
      const pendingRecents = untrack(() => recentVideos.filter((video) =>
        video.ownerNpub === npub
        && video.treeName === treeName
        && !resolvedRecentCardInfoByKey[video.key]?.thumbnailUrl
      ));
      if (pendingRecents.length > 0) {
        void doDetectRecentMedia(pendingRecents);
      }
    });

    return () => {
      unsubscribe();
    };
  });

  async function detectPlaylistsInFeed(videos: VideoItem[]) {
    // First, instantly populate from cache (no layout shift for known items)
    const updates: Record<string, PlaylistInfo> = {};
    const uncached: VideoItem[] = [];

    for (const video of videos) {
      const resolvedRootCid = resolveFeedVideoRootCid(video);

      // Check persistent cache first
      const persistentCached = getFeedPlaylistInfo(video.key);
      if (persistentCached !== undefined) {
        if (shouldRefreshPlaylistCardInfo(persistentCached)) {
          uncached.push(resolvedRootCid ? { ...video, rootCid: resolvedRootCid } : video);
          continue;
        }
        if (feedPlaylistInfo[video.key] === undefined) {
          updates[video.key] = persistentCached;
        }
        continue;
      }
      if (!video.ownerNpub || !video.treeName) continue;

      const cached = getCachedPlaylistInfo(video.ownerNpub, video.treeName);
      if (cached !== undefined) {
        if (shouldRefreshPlaylistCardInfo(cached)) {
          uncached.push(resolvedRootCid ? { ...video, rootCid: resolvedRootCid } : video);
          continue;
        }
        const info = cached ?? { videoCount: 0 };
        updates[video.key] = info;
        setFeedPlaylistInfo(video.key, info);
      } else if (video.ownerNpub && video.treeName) {
        uncached.push(resolvedRootCid ? { ...video, rootCid: resolvedRootCid } : video);
      }
    }

    // Apply cached updates immediately
    if (Object.keys(updates).length > 0) {
      feedPlaylistInfo = { ...feedPlaylistInfo, ...updates };
    }

    // Debounce async detection for uncached items
    if (uncached.length > 0) {
      pendingVideos = [...pendingVideos, ...uncached];
      if (detectTimer) clearTimeout(detectTimer);
      detectTimer = setTimeout(() => {
        const toProcess = pendingVideos;
        pendingVideos = [];
        detectTimer = null;
        doDetectPlaylists(toProcess);
      }, 100);
    }
  }

  async function doDetectPlaylists(videos: VideoItem[]) {
    const detectOne = async (video: VideoItem) => {
      const rootCid = resolveFeedVideoRootCid(video) ?? await resolveFeedVideoRootCidAsync(video);
      if (!rootCid) {
        schedulePlaylistRetry(video);
        return;
      }
      const info = await detectPlaylistForCard(rootCid, video.ownerNpub!, video.treeName);
      const playbackRootCid = info?.rootCid ?? rootCid;
      let thumbnailUrl = info?.thumbnailUrl;
      const thumbnailRootCid = await resolveReadableThumbnailRoot({
        rootCid: playbackRootCid,
        npub: video.ownerNpub!,
        treeName: video.treeName,
        priority: 'background',
      }) ?? playbackRootCid;
      if (!sameCid(thumbnailRootCid, playbackRootCid)) {
        const thumbnailInfo = await detectPlaylistForCard(thumbnailRootCid, video.ownerNpub!, video.treeName, {
          cacheScope: 'root',
        });
        thumbnailUrl = thumbnailInfo?.thumbnailUrl ?? thumbnailUrl;
      }
      const result: PlaylistInfo = info
        ? { ...info, thumbnailUrl: thumbnailUrl ?? info.thumbnailUrl }
        : { videoCount: 0, ...(thumbnailUrl ? { thumbnailUrl } : {}) };
      setFeedPlaylistInfo(video.key, result);
      feedPlaylistInfo = { ...feedPlaylistInfo, [video.key]: result };
      if (result.thumbnailUrl || result.videoPath) {
        clearPlaylistRetry(video.key);
      } else {
        schedulePlaylistRetry(video);
      }
    };

    await Promise.allSettled(videos.map(detectOne));
  }

  function detectRecentMedia(videos: VideoItem[]) {
    const uncached = videos.filter((video) => {
      if (!video.ownerNpub || !video.treeName) return false;
      const existing = resolvedRecentCardInfoByKey[video.key];
      return !existing?.thumbnailUrl && !existing?.videoPath;
    });

    if (uncached.length === 0) {
      return;
    }

    pendingRecentVideos = [...pendingRecentVideos, ...uncached];
    if (recentDetectTimer) clearTimeout(recentDetectTimer);
    recentDetectTimer = setTimeout(() => {
      const toProcess = pendingRecentVideos;
      pendingRecentVideos = [];
      recentDetectTimer = null;
      void doDetectRecentMedia(toProcess);
    }, 100);
  }

  async function doDetectRecentMedia(videos: VideoItem[]) {
    const detectOne = async (video: VideoItem) => {
      if (!video.ownerNpub || !video.treeName) return;

      const latestRootCid = resolveFeedVideoRootCid(video)
        ?? getTreeRootSync(video.ownerNpub, video.treeName)
        ?? await resolveFeedVideoRootCidAsync(video, 3000)
        ?? await waitForTreeRoot(video.ownerNpub, video.treeName, 8000);
      if (!latestRootCid) {
        scheduleRecentRetry(video);
        return;
      }

      const rootCid = await resolveReadableVideoRoot({
        rootCid: latestRootCid,
        npub: video.ownerNpub,
        treeName: video.treeName,
        videoId: video.videoId || null,
        priority: 'background',
      }) ?? latestRootCid;

      const info = await detectVideoCardInfo(rootCid, video.ownerNpub, video.treeName, video.videoId);
      const mediaRootCid = info?.rootCid ?? rootCid;
      let thumbnailUrl = info?.thumbnailUrl;
      const thumbnailRootCid = await resolveReadableThumbnailRoot({
        rootCid: mediaRootCid,
        npub: video.ownerNpub,
        treeName: video.treeName,
        videoId: video.videoId || null,
        priority: 'background',
      }) ?? mediaRootCid;
      if (!sameCid(thumbnailRootCid, mediaRootCid)) {
        const thumbnailInfo = await detectVideoCardInfo(
          thumbnailRootCid,
          video.ownerNpub,
          video.treeName,
          video.videoId,
          { exactRoot: true },
        );
        thumbnailUrl = thumbnailInfo?.thumbnailUrl ?? thumbnailUrl;
      }
      const fallbackThumbnailUrl = getStableThumbnailUrl({
        rootCid: mediaRootCid,
        npub: video.ownerNpub,
        treeName: video.treeName,
        videoId: video.videoId || undefined,
        allowAliasFallback: true,
      });
      const nextInfo: RecentVideoCardInfo = {
        ...(info ?? { videoCount: 0 }),
        rootCid: info?.rootCid ?? rootCid,
        thumbnailUrl: thumbnailUrl ?? fallbackThumbnailUrl ?? undefined,
      };

      setRecentVideoCardInfo(video.key, nextInfo);
      recentCardInfoByKey = { ...recentCardInfoByKey, [video.key]: nextInfo };
      if (nextInfo.thumbnailUrl || nextInfo.videoPath) {
        clearRecentRetry(video.key);
      } else {
        scheduleRecentRetry(video);
      }
    };

    await Promise.allSettled(videos.map(detectOne));
  }

  $effect(() => {
    detectRecentMedia(recentVideos);
  });

  // Get user's follows
  let follows = $state<string[]>([]);

  // Fallback follows from default content pubkey (fetched directly, not via social graph)
  let fallbackFollows = $state<string[]>([]);
  let fallbackFetched = false;

  // Compute effective follows: user's follows + fallback if < threshold
  let effectiveFollows = $derived.by(() => {
    // If user has enough follows, use them directly
    if (follows.length >= MIN_FOLLOWS_THRESHOLD) {
      return follows;
    }

    // Otherwise, augment with default pubkey + its follows
    // Access fallbackFollows directly (Svelte 5 tracks $state automatically)
    const combined = new SvelteSet(follows);
    combined.add(DEFAULT_BOOTSTRAP_PUBKEY); // Include the default user itself
    for (const pk of DEFAULT_VIDEO_FEED_PUBKEYS) {
      combined.add(pk);
    }
    for (const pk of fallbackFollows) {
      combined.add(pk);
    }

    return Array.from(combined);
  });

  // Track if we're using fallback content
  let usingFallback = $derived(follows.length < MIN_FOLLOWS_THRESHOLD);

  // Fetch fallback follow list when needed (via subscription, not fetchEvents which hangs)
  let fallbackSub: { stop: () => void } | null = null;
  $effect(() => {
    if (!workerReady) return;
    if (usingFallback && !fallbackFetched) {
      fallbackFetched = true;
      let latestTimestamp = 0;
      let latestEventId: string | null = null;
      const sub = ndk.subscribe(
        { kinds: [3], authors: [DEFAULT_BOOTSTRAP_PUBKEY] },
        { closeOnEose: false }
      );

      sub.on('event', (event) => {
        const eventTime = event.created_at || 0;
        if (eventTime < latestTimestamp) return;
        if (eventTime === latestTimestamp && event.id && event.id === latestEventId) return;
        latestTimestamp = eventTime;
        latestEventId = event.id ?? null;

        const followPubkeys = event.tags
          .filter((t: string[]) => t[0] === 'p' && t[1])
          .map((t: string[]) => t[1]);

        fallbackFollows = [...followPubkeys];
      });

      fallbackSub = { stop: () => sub.stop() };
    }

    return () => {
      if (fallbackSub) {
        fallbackSub.stop();
        fallbackSub = null;
      }
    };
  });

  $effect(() => {
    // Track userPubkey to trigger re-run when it changes
    const pk = userPubkey;

    // Reset when userPubkey changes
    if (!pk) {
      untrack(() => {
        follows = [];
        followsLoading = false;
      });
      return;
    }

    untrack(() => { followsLoading = true; });
    const store = createFollowsStore(pk);
    const unsub = store.subscribe(value => {
      untrack(() => {
        follows = value?.follows || [];
        followsLoading = false;
      });
    });
    return unsub;
  });

  // Videos from followed users - single multi-author subscription
  let followedUsersVideos = $state<VideoItem[]>([]);
  let videoSubUnsub: (() => void) | null = null;

  // Track if initial feed load is in progress (prevents premature infinite scroll)
  let feedLoading = $state(true);

  // Videos liked or commented by followed users
  let socialVideos = $state<VideoItem[]>([]);
  let socialSubUnsub: (() => void) | null = null;

  $effect(() => {
    if (!workerReady) return;
    // Track effectiveFollows to trigger re-run when it changes (includes fallback)
    const currentFollows = effectiveFollows;
    // Track userPubkey to include own videos
    const myPubkey = userPubkey;
    // Clean up previous subscription
    untrack(() => {
      if (videoSubUnsub) {
        videoSubUnsub();
        videoSubUnsub = null;
      }
    });

    // Clear cache only when user actually changes
    clearCacheIfUserChanged(myPubkey);

    // Include self + follows (deduplicated)
    const pubkeysToCheck = new SvelteSet(currentFollows);
    if (myPubkey) {
      pubkeysToCheck.add(myPubkey);
    }

    if (pubkeysToCheck.size === 0) {
      untrack(() => { followedUsersVideos = []; });
      return;
    }

    // Convert to array of pubkeys (no limit - single subscription handles all)
    const authors = Array.from(pubkeysToCheck);

    // Debounce updates to batch rapid events
    let updateTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleUpdate = () => {
      // Clear existing timer and reschedule - this ensures we always get latest data
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = setTimeout(() => {
        updateTimer = null;
        const allVideos = videosByKey.values();
        // Force new array reference and update state
        followedUsersVideos = [...allVideos];
        feedLoading = false;  // Initial load complete
        detectPlaylistsInFeed(allVideos);
      }, 100);
    };

    // Render existing cached videos immediately AND schedule update
    // This ensures back-nav shows cached content instantly
    const cachedVideos = getCachedVideos();
    if (cachedVideos.length > 0) {
      // Use queueMicrotask to update state after effect completes
      queueMicrotask(() => {
        followedUsersVideos = [...cachedVideos];
      });
    }
    // Schedule update to catch any new videos from subscription
    scheduleUpdate();

    // Single subscription for all authors' hashtree events
    const sub = ndk.subscribe({
      kinds: [30078],
      authors,
      '#l': ['hashtree'],
    }, { closeOnEose: false });

    sub.on('event', (event) => {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      if (!dTag || !dTag.startsWith('videos/')) return;

      const ownerPubkey = event.pubkey;
      const ownerNpub = pubkeyToNpub(ownerPubkey);
      if (!ownerNpub) return;

      const key = `${ownerNpub}/${dTag}`;
      const eventTimestamp = event.created_at || 0;

      // Parse visibility from tags
      const hashTag = event.tags.find(t => t[0] === 'hash')?.[1];
      if (!hashTag) {
        // Deleted tree - record deletion and remove from caches
        const deletedAt = event.created_at || 0;
        recordDeletedVideo(ownerNpub, dTag, deletedAt);
        const removed = removeVideoFromCaches(ownerNpub, dTag, deletedAt);
        if (removed) scheduleUpdate();
        return;
      }

      const keyTag = event.tags.find(t => t[0] === 'key')?.[1]; // Encryption key for public trees
      const hasEncryptedKey = event.tags.some(t => t[0] === 'encryptedKey');
      const hasSelfEncryptedKey = event.tags.some(t => t[0] === 'selfEncryptedKey');
      const visibility = hasEncryptedKey ? 'link-visible' : (hasSelfEncryptedKey ? 'private' : 'public');

      // Only include public videos
      if (visibility !== 'public') return;

      // Skip deleted videos (unless newer event re-creates them)
      const deletedAt = getDeletedVideoTimestamp(ownerNpub, dTag);
      if (deletedAt && deletedAt >= (event.created_at || 0)) {
        return;
      }
      if (deletedAt && deletedAt < (event.created_at || 0)) {
        clearDeletedVideo(ownerNpub, dTag);
      }

      const existing = videosByKey.get(key);

      // Allow equal-timestamp events to hydrate cached feed entries that are still missing root CIDs.
      if (shouldSkipFeedEvent(existing, eventTimestamp)) {
        return;
      }

      const hash = fromHex(hashTag);
      const encKey = keyTag ? fromHex(keyTag) : undefined;
      updateSubscriptionCache(key, hash, encKey, {
        updatedAt: eventTimestamp,
        visibility,
      });

      const title = dTag.slice(7); // Remove 'videos/' prefix
      videosByKey.set(key, {
        key,
        title,
        ownerPubkey,
        ownerNpub,
        treeName: dTag,
        rootCid: { hash, key: encKey },
        visibility,
        href: `#/${ownerNpub}/${encodeTreeNameForUrl(dTag)}`,
        timestamp: eventTimestamp,
      });

      void buildIndexedVideoHref(ownerNpub, dTag, { snapshotEvent: event }).then((href) =>
        indexVideo({
          title,
          pubkey: ownerPubkey,
          treeName: dTag,
          href,
          nhash: nhashEncode({ hash, key: encKey }),
          timestamp: event.created_at || Date.now(),
        })
      ).catch(() => {
        void indexVideo({
          title,
          pubkey: ownerPubkey,
          treeName: dTag,
          href: buildTreeRouteHref(ownerNpub, dTag),
          nhash: nhashEncode({ hash, key: encKey }),
          timestamp: event.created_at || Date.now(),
        });
      });

      scheduleUpdate();
    });

    untrack(() => {
      videoSubUnsub = () => sub.stop();
    });

    return () => {
      if (updateTimer) clearTimeout(updateTimer);
      sub.stop();
    };
  });

  // Subscribe to liked and commented videos from self + followed users
  $effect(() => {
    if (!workerReady) return;
    const currentFollows = effectiveFollows;
    const myPubkey = userPubkey;
    // Clean up previous subscription
    untrack(() => {
      if (socialSubUnsub) {
        socialSubUnsub();
        socialSubUnsub = null;
      }
    });

    // Include self + follows
    const authorsSet = new SvelteSet(currentFollows);
    if (myPubkey) {
      authorsSet.add(myPubkey);
    }

    if (authorsSet.size === 0) {
      untrack(() => { socialVideos = []; });
      return;
    }

    const authors = Array.from(authorsSet);

    // Render existing cached videos immediately (instant back-nav)
    const cachedSocial = getCachedSocialVideos();
    if (cachedSocial.length > 0) {
      untrack(() => {
        socialVideos = cachedSocial;
      });
    }

    // Debounce updates
    let updateTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleSocialUpdate = () => {
      if (updateTimer) return;
      updateTimer = setTimeout(() => {
        updateTimer = null;
        // Don't use untrack - we want reactivity to trigger feedVideos derivation
        socialVideos = socialVideosByKey.values();
      }, 50);
    };

    // Parse video identifier from 'i' tag and create VideoItem
    // Format: "npub.../videos%2FVideoName" or just "nhash..."
    function parseVideoFromIdentifier(identifier: string, reactorPubkey: string, timestamp: number): VideoItem | null {
      // Skip nhash-only identifiers for now (no profile info)
      if (identifier.startsWith('nhash')) return null;

      // Try to parse npub/treeName format
      const match = identifier.match(/^(npub1[a-z0-9]+)\/(.+)$/);
      if (!match) return null;

      const [, ownerNpub, encodedTreeName] = match;
      let treeName: string;
      try {
        treeName = decodeURIComponent(encodedTreeName);
      } catch {
        treeName = encodedTreeName;
      }

      if (!treeName.startsWith('videos/')) return null;

      const ownerPubkey = npubToPubkey(ownerNpub);
      if (!ownerPubkey) return null;

      const key = `${ownerNpub}/${treeName}`;
      const deletedAt = getDeletedVideoTimestamp(ownerNpub, treeName);
      if (deletedAt) return null;
      return {
        key,
        title: treeName.slice(7), // Remove 'videos/' prefix
        ownerPubkey,
        ownerNpub,
        treeName,
        visibility: 'public',
        href: `#/${ownerNpub}/${encodeTreeNameForUrl(treeName)}`,
        timestamp,
        // Track who reacted for potential UI display
        reactorPubkey,
      };
    }

    // Subscribe to kind 17 (reactions/likes) with k=video tag
    const likesSub = ndk.subscribe({
      kinds: [17 as number],
      authors,
      '#k': ['video'],
    }, { closeOnEose: false });

    likesSub.on('event', (event) => {
      if (!event.id || socialSeenEventIds.has(event.id)) return;
      socialSeenEventIds.add(event.id);

      // Find 'i' tag with video identifier
      const iTag = event.tags.find(t => t[0] === 'i')?.[1];
      if (!iTag) return;

      const video = parseVideoFromIdentifier(iTag, event.pubkey, event.created_at || 0);
      if (!video) return;

      // Index for search (discovered via public reaction data)
      const ownerPubkey = video.ownerPubkey;
      const ownerNpub = video.ownerNpub;
      const treeName = video.treeName;
      if (ownerPubkey && ownerNpub && treeName) {
        void buildIndexedVideoHref(ownerNpub, treeName).then((href) =>
          indexVideo({
            title: video.title,
            pubkey: ownerPubkey,
            treeName,
            href,
            timestamp: video.timestamp || Date.now(),
          })
        ).catch(() => {
          void indexVideo({
            title: video.title,
            pubkey: ownerPubkey,
            treeName,
            href: buildTreeRouteHref(ownerNpub, treeName),
            timestamp: video.timestamp || Date.now(),
          });
        });
      }

      const existing = socialVideosByKey.get(video.key);
      // Keep the most recent interaction timestamp
      if (!existing || (video.timestamp && video.timestamp > (existing.timestamp || 0))) {
        socialVideosByKey.set(video.key, video);
        scheduleSocialUpdate();
      }
    });

    // Subscribe to kind 1111 (NIP-22 comments) with k=video tag
    const commentsSub = ndk.subscribe({
      kinds: [1111 as number],
      authors,
      '#k': ['video'],
    }, { closeOnEose: false });

    commentsSub.on('event', (event) => {
      if (!event.id || socialSeenEventIds.has(event.id)) return;
      socialSeenEventIds.add(event.id);

      // Find 'i' tag with video identifier
      const iTag = event.tags.find(t => t[0] === 'i')?.[1];
      if (!iTag) return;

      const video = parseVideoFromIdentifier(iTag, event.pubkey, event.created_at || 0);
      if (!video) return;

      // Index for search (discovered via public comment data)
      const ownerPubkey = video.ownerPubkey;
      const ownerNpub = video.ownerNpub;
      const treeName = video.treeName;
      if (ownerPubkey && ownerNpub && treeName) {
        void buildIndexedVideoHref(ownerNpub, treeName).then((href) =>
          indexVideo({
            title: video.title,
            pubkey: ownerPubkey,
            treeName,
            href,
            timestamp: video.timestamp || Date.now(),
          })
        ).catch(() => {
          void indexVideo({
            title: video.title,
            pubkey: ownerPubkey,
            treeName,
            href: buildTreeRouteHref(ownerNpub, treeName),
            timestamp: video.timestamp || Date.now(),
          });
        });
      }

      const existing = socialVideosByKey.get(video.key);
      // Keep the most recent interaction timestamp
      if (!existing || (video.timestamp && video.timestamp > (existing.timestamp || 0))) {
        socialVideosByKey.set(video.key, video);
        scheduleSocialUpdate();
      }
    });

    untrack(() => {
      socialSubUnsub = () => {
        likesSub.stop();
        commentsSub.stop();
      };
    });

    return () => {
      if (updateTimer) clearTimeout(updateTimer);
      likesSub.stop();
      commentsSub.stop();
    };
  });

  let feedPage = $state(0);
  let loadingMore = $state(false);
  const FEED_PAGE_SIZE = 12;

  // Combine all discovered videos for the feed (unique)
  let feedVideos = $derived.by(() => {
    const seen = new SvelteSet<string>();
    const result: VideoItem[] = [];

    // Add followed users' videos first
    for (const video of followedUsersVideos) {
      const key = `${video.ownerNpub}/${video.treeName}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(video);
      }
    }

    // Add videos liked/commented by followed users
    for (const video of socialVideos) {
      const key = `${video.ownerNpub}/${video.treeName}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(video);
      }
    }

    // Order with interleaving to prevent one owner from dominating the feed
    const targetCount = (feedPage + 1) * FEED_PAGE_SIZE;
    return orderFeedWithInterleaving(result, targetCount);
  });

  let resolvedFeedVideoByKey = $derived.by(() => {
    const map: Record<string, (typeof $feedStore)[number]> = {};
    for (const video of $feedStore) {
      if (!video.ownerNpub || !video.treeName) continue;
      map[`${video.ownerNpub}/${video.treeName}`] = video;
    }
    return map;
  });

  // Sync feedVideos to the shared store for use in sidebar
  $effect(() => {
    setFeedVideos(feedVideos.map(v => {
      const info = feedPlaylistInfo[v.key];
      return {
        href: v.href,
        title: info?.title || v.title,
        ownerPubkey: v.ownerPubkey,
        ownerNpub: v.ownerNpub,
        treeName: v.treeName,
        videoId: v.videoId,
        duration: v.duration ?? info?.duration,
        thumbnailUrl: info?.thumbnailUrl,
        timestamp: v.timestamp,
        rootCid: v.rootCid,
      };
    }));
  });

  // Track total unique videos (computed during feedVideos derivation)
  let totalUniqueVideos = $derived.by(() => {
    const seen = new SvelteSet<string>();
    for (const video of followedUsersVideos) {
      seen.add(`${video.ownerNpub}/${video.treeName}`);
    }
    for (const video of socialVideos) {
      seen.add(`${video.ownerNpub}/${video.treeName}`);
    }
    return seen.size;
  });

  function loadMoreFeed() {
    if (loadingMore) return;
    if (feedVideos.length >= totalUniqueVideos) return;

    loadingMore = true;
    feedPage++;
    setTimeout(() => loadingMore = false, 100);
  }

  // Control empty state visibility with delay
  $effect(() => {
    const hasContent = recentVideos.length > 0 || feedVideos.length > 0 || followedUsersVideos.length > 0;
    const isLoading = followsLoading;

    if (hasContent || isLoading) {
      // Clear timer and hide empty state immediately when content appears or loading
      if (emptyStateTimer) {
        clearTimeout(emptyStateTimer);
        emptyStateTimer = null;
      }
      showEmptyState = false;
    } else {
      // Start timer to show empty state after delay
      if (!emptyStateTimer && !showEmptyState) {
        emptyStateTimer = setTimeout(() => {
          showEmptyState = true;
          emptyStateTimer = null;
        }, 2000);
      }
    }
  });

  function npubToPubkey(npub: string): string | null {
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        return decoded.data as string;
      }
    } catch {}
    return null;
  }

  function pubkeyToNpub(pubkey: string): string | null {
    try {
      return nip19.npubEncode(pubkey);
    } catch {}
    return null;
  }

  function buildRecentHref(item: RecentItem): string {
    // Encode treeName in path: /npub/treeName -> /npub/encodedTreeName
    let encodedPath: string;
    if (item.treeName) {
      // For playlist videos, encode treeName and videoId separately
      encodedPath = item.videoId
        ? `/${item.npub}/${encodeURIComponent(item.treeName)}/${encodeURIComponent(item.videoId)}`
        : `/${item.npub}/${encodeURIComponent(item.treeName)}`;
    } else {
      encodedPath = item.path;
    }
    const base = `#${encodedPath}`;
    return item.linkKey ? `${base}?k=${item.linkKey}` : base;
  }

  </script>

<div class="flex-1">
  <div class="max-w-7xl mx-auto p-4 md:p-6">
    <!-- Recent Videos Section -->
    {#if recentVideos.length > 0}
      <section class="mb-10">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold text-text-1">Recent</h2>
          <button
            class="btn-ghost text-xs"
            onclick={() => clearRecentsByPrefix('videos/')}
          >
            Clear
          </button>
        </div>
        <div class="relative -mx-4">
          <div class="flex gap-3 overflow-x-auto pb-2 px-4 scrollbar-thin">
            {#each recentVideos as video (video.href)}
              {@const recentCardInfo = resolvedRecentCardInfoByKey[video.key]}
              <div class="shrink-0 w-64 md:w-80">
                <VideoCard
                  href={video.href}
                  title={video.title}
                  duration={video.duration ?? recentCardInfo?.duration}
                  thumbnailUrl={recentCardInfo?.thumbnailUrl}
                  videoPath={recentCardInfo?.videoPath}
                  ownerPubkey={video.ownerPubkey}
                  ownerNpub={video.ownerNpub}
                  treeName={video.treeName}
                  videoId={video.videoId}
                  visibility={video.visibility}
                  rootCid={recentCardInfo?.rootCid ?? null}
                  rootHashHex={recentCardInfo?.rootCid?.hash ? toHex(recentCardInfo.rootCid.hash) : null}
                  timestamp={video.timestamp}
                  noHover
                />
              </div>
            {/each}
          </div>
          <!-- Scroll fade indicator (right side only) -->
          <div class="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-surface-0 via-surface-0/80 to-transparent"></div>
        </div>
      </section>
    {/if}

    <!-- Feed Section -->
    {#if feedVideos.length > 0}
      <section>
        <InfiniteScroll onLoadMore={loadMoreFeed} loading={feedLoading}>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {#each feedVideos as video (video.href)}
              {@const playlistInfo = feedPlaylistInfo[video.key]}
              {@const resolvedVideo = resolvedFeedVideoByKey[video.key]}
              {@const fallbackPlaylistThumbnail = getStableThumbnailUrl({
                thumbnailUrl: resolvedVideo?.thumbnailUrl ?? playlistInfo?.thumbnailUrl,
                rootCid: resolvedVideo?.rootCid ?? video.rootCid ?? null,
                npub: resolvedVideo?.ownerNpub ?? video.ownerNpub,
                treeName: resolvedVideo?.treeName ?? video.treeName,
                videoId: resolvedVideo?.videoId ?? (video.videoId || undefined),
                allowAliasFallback: true,
              })}
              {#if playlistInfo && playlistInfo.videoCount >= 1}
                <PlaylistCard
                  href={video.href}
                  title={video.title}
                  videoCount={playlistInfo.videoCount}
                  thumbnailUrl={playlistInfo.thumbnailUrl ?? fallbackPlaylistThumbnail}
                  ownerNpub={resolvedVideo?.ownerNpub ?? video.ownerNpub}
                  treeName={resolvedVideo?.treeName ?? video.treeName}
                  rootCid={playlistInfo.rootCid ?? resolvedVideo?.rootCid ?? video.rootCid ?? null}
                  rootHashHex={getRootHashHex(playlistInfo.rootCid ?? resolvedVideo?.rootCid ?? video.rootCid)}
                  ownerPubkey={video.ownerPubkey}
                  visibility={video.visibility}
                />
              {:else}
                <VideoCard
                  href={video.href}
                  title={playlistInfo?.title || resolvedVideo?.title || video.title}
                  duration={resolvedVideo?.duration ?? video.duration ?? playlistInfo?.duration}
                  thumbnailUrl={resolvedVideo?.thumbnailUrl ?? playlistInfo?.thumbnailUrl}
                  videoPath={resolvedVideo?.videoPath ?? playlistInfo?.videoPath ?? video.videoPath}
                  ownerPubkey={resolvedVideo?.ownerPubkey ?? video.ownerPubkey}
                  ownerNpub={resolvedVideo?.ownerNpub ?? video.ownerNpub}
                  treeName={resolvedVideo?.treeName ?? video.treeName}
                  videoId={resolvedVideo?.videoId ?? video.videoId}
                  visibility={resolvedVideo?.visibility ?? video.visibility}
                  rootCid={resolvedVideo?.rootCid ?? video.rootCid ?? null}
                  rootHashHex={getRootHashHex(resolvedVideo?.rootCid ?? video.rootCid)}
                  timestamp={resolvedVideo?.timestamp ?? video.timestamp}
                />
              {/if}
            {/each}
          </div>
        </InfiniteScroll>

        {#if loadingMore}
          <div class="flex justify-center py-4">
            <span class="i-lucide-loader-2 animate-spin text-text-3"></span>
          </div>
        {/if}
      </section>
    {/if}

    <!-- Empty state when no content (delayed to avoid flash) -->
    {#if showEmptyState}
      <div class="text-center py-12 text-text-3">
        <p>No videos found. {#if !isLoggedIn}Sign in to upload videos.{/if}</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .scrollbar-thin::-webkit-scrollbar {
    height: 6px;
  }
  .scrollbar-thin::-webkit-scrollbar-track {
    background: transparent;
  }
  .scrollbar-thin::-webkit-scrollbar-thumb {
    background: var(--surface-3);
    border-radius: 3px;
  }
  .scrollbar-thin::-webkit-scrollbar-thumb:hover {
    background: var(--surface-4);
  }
</style>
