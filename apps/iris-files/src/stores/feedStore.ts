/**
 * Store for caching feed videos across components
 * Populated by VideoHome, consumed by FeedSidebar
 */
import { writable, get } from 'svelte/store';
import type { CID } from '@hashtree/core';
import { ndk, pubkeyToNpub, nostrStore, type NostrState } from '../nostr';
import { createFollowsStore, getFollowsSync } from './follows';
import { getFollows as getSocialGraphFollows } from '../utils/socialGraph';
import { getWorkerAdapter, waitForWorkerAdapter } from '../lib/workerInit';
import { DEFAULT_BOOTSTRAP_PUBKEY, DEFAULT_VIDEO_FEED_PUBKEYS } from '../utils/constants';
import { fromHex, toHex } from '@hashtree/core';
import { orderFeedWithInterleaving } from '../utils/feedOrder';
import { clearDeletedVideo, getDeletedVideoTimestamp, recordDeletedVideo } from './videoDeletes';
import { isHtreeDebugEnabled, logHtreeDebug } from '../lib/htreeDebug';
import { getAppType } from '../appType';
import { detectPlaylistForCard, getCachedPlaylistInfo, shouldRefreshPlaylistCardInfo } from './playlist';
import { resolveFeedVideoRootCid, resolveFeedVideoRootCidAsync } from '../lib/videoFeedRoot';
import { onCacheUpdate } from '../treeRootCache';
import { resolveReadableThumbnailRoot, resolveReadableVideoRoot } from '../lib/readableVideoRoot';

const log = (event: string, data?: Record<string, unknown>) => {
  if (!isHtreeDebugEnabled()) return;
  logHtreeDebug(`feed:${event}`, data);
};

const MIN_FOLLOWS_THRESHOLD = 5;
const RELAY_WAIT_TIMEOUT_MS = 10000;
const RELAY_RETRY_TIMEOUT_MS = 30000;
const EMPTY_FEED_RETRY_MS = 15000;
const EMPTY_FEED_MAX_RETRIES = 3;
const FEED_MEDIA_RESOLUTION_MAX_RETRIES = 8;

let retryOnRelayScheduled = false;
let emptyFeedRetryTimer: ReturnType<typeof setTimeout> | null = null;
let emptyFeedRetryCount = 0;
let activeSubscription: { stop: () => void } | null = null;
const attemptedFeedMediaKeys = new Set<string>();
const cachedFeedMediaByKey = new Map<string, Partial<FeedVideo>>();
const inFlightFeedMediaKeys = new Set<string>();
const feedMediaRetryCounts = new Map<string, number>();
const feedMediaRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getNostrState(): NostrState {
  return get(nostrStore) as NostrState;
}

function clearEmptyFeedRetry(): void {
  if (emptyFeedRetryTimer) {
    clearTimeout(emptyFeedRetryTimer);
    emptyFeedRetryTimer = null;
  }
  emptyFeedRetryCount = 0;
}

function scheduleEmptyFeedRetry(reason: string): void {
  if (emptyFeedRetryTimer) return;
  if (emptyFeedRetryCount >= EMPTY_FEED_MAX_RETRIES) {
    log('retry:empty:maxed', { reason, attempts: emptyFeedRetryCount });
    return;
  }
  emptyFeedRetryCount += 1;
  log('retry:empty:schedule', { reason, delayMs: EMPTY_FEED_RETRY_MS, attempt: emptyFeedRetryCount });
  emptyFeedRetryTimer = setTimeout(() => {
    emptyFeedRetryTimer = null;
    if (get(feedStore).length === 0) {
      log('retry:empty:run', { attempt: emptyFeedRetryCount });
      void fetchFeedVideos();
    } else {
      clearEmptyFeedRetry();
    }
  }, EMPTY_FEED_RETRY_MS);
}

export interface FeedVideo {
  href: string;
  title: string;
  ownerPubkey: string | null;
  ownerNpub: string | null;
  treeName: string | null;
  videoId?: string;
  duration?: number;
  thumbnailUrl?: string;
  videoPath?: string;
  visibility?: string;
  timestamp?: number;
  rootCid?: CID | null;
}

export const feedStore = writable<FeedVideo[]>([]);

onCacheUpdate((npub, treeName) => {
  const videos = get(feedStore);
  if (!videos.some((video) => video.ownerNpub === npub && video.treeName === treeName)) {
    return;
  }
  queueFeedVideoMediaResolution(videos);
});

function resetFeedMediaResolution(): void {
  attemptedFeedMediaKeys.clear();
  cachedFeedMediaByKey.clear();
  inFlightFeedMediaKeys.clear();
  for (const timer of feedMediaRetryTimers.values()) {
    clearTimeout(timer);
  }
  feedMediaRetryTimers.clear();
  feedMediaRetryCounts.clear();
}

function getFeedMediaResolutionKey(video: FeedVideo): string | null {
  if (!video.ownerNpub || !video.treeName) return null;
  const rootCid = resolveFeedVideoRootCid(video);
  if (!rootCid?.hash) {
    return `${video.ownerNpub}/${video.treeName}`;
  }
  return `${video.ownerNpub}/${video.treeName}/${toHex(rootCid.hash)}`;
}

function hasResolvedFeedVideoMedia(video: FeedVideo, cached?: Partial<FeedVideo>): boolean {
  const resolvedRootCid = cached?.rootCid ?? resolveFeedVideoRootCid(video);
  const resolvedThumbnailUrl = cached?.thumbnailUrl ?? video.thumbnailUrl;
  const resolvedVideoPath = cached?.videoPath ?? video.videoPath;
  const resolvedDuration = cached?.duration ?? video.duration;

  return !!resolvedRootCid
    && (typeof resolvedDuration === 'number')
    && (!!resolvedThumbnailUrl || !!resolvedVideoPath);
}

function shouldResolveFeedVideoMedia(video: FeedVideo): boolean {
  if (!video.ownerNpub || !video.treeName) return false;
  const resolutionKey = getFeedMediaResolutionKey(video);
  if (!resolutionKey) return false;
  const cached = cachedFeedMediaByKey.get(resolutionKey);
  if (!cached) return true;
  return !hasResolvedFeedVideoMedia(video, cached);
}

function sameCid(a?: CID | null, b?: CID | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return toHex(a.hash) === toHex(b.hash)
    && ((a.key && b.key && toHex(a.key) === toHex(b.key)) || (!a.key && !b.key));
}

function applyCachedFeedMedia(videos: FeedVideo[]): FeedVideo[] {
  let changed = false;
  const nextVideos = videos.map((video) => {
    const resolutionKey = getFeedMediaResolutionKey(video);
    if (!resolutionKey) return video;

    const cached = cachedFeedMediaByKey.get(resolutionKey);
    if (!cached) return video;

    const nextTitle = cached.title ?? video.title;
    const nextDuration = cached.duration ?? video.duration;
    const nextThumbnailUrl = cached.thumbnailUrl ?? video.thumbnailUrl;
    const nextVideoPath = cached.videoPath ?? video.videoPath;
    const nextRootCid = cached.rootCid ?? video.rootCid;

    if (
      nextTitle === video.title &&
      nextDuration === video.duration &&
      nextThumbnailUrl === video.thumbnailUrl &&
      nextVideoPath === video.videoPath &&
      sameCid(nextRootCid, video.rootCid)
    ) {
      return video;
    }

    changed = true;
    return {
      ...video,
      title: nextTitle,
      duration: nextDuration,
      thumbnailUrl: nextThumbnailUrl,
      videoPath: nextVideoPath,
      rootCid: nextRootCid,
    };
  });

  return changed ? nextVideos : videos;
}

export async function getFeedVideoResolvedMedia(video: FeedVideo): Promise<Partial<FeedVideo> | null> {
  const latestRootCid = await resolveFeedVideoRootCidAsync(video, 8000);
  if (!latestRootCid || !video.ownerNpub || !video.treeName) return null;

  const rootCid = await resolveReadableVideoRoot({
    rootCid: latestRootCid,
    npub: video.ownerNpub,
    treeName: video.treeName,
    videoId: video.videoId ?? null,
    priority: 'background',
  }) ?? latestRootCid;

  const cached = getCachedPlaylistInfo(video.ownerNpub, video.treeName);
  const playbackInfo = cached !== undefined && !shouldRefreshPlaylistCardInfo(cached)
    ? cached
    : await detectPlaylistForCard(rootCid, video.ownerNpub, video.treeName);
  const playbackRootCid = playbackInfo?.rootCid ?? rootCid;
  let thumbnailInfo: Partial<FeedVideo> | null = null;
  let thumbnailUrl = playbackInfo?.thumbnailUrl;

  const thumbnailRootCid = await resolveReadableThumbnailRoot({
    rootCid: playbackRootCid,
    npub: video.ownerNpub,
    treeName: video.treeName,
    videoId: video.videoId ?? null,
    priority: 'background',
  }) ?? playbackRootCid;

  if (!sameCid(thumbnailRootCid, playbackRootCid)) {
    thumbnailInfo = await detectPlaylistForCard(thumbnailRootCid, video.ownerNpub, video.treeName, {
      cacheScope: 'root',
    });
    thumbnailUrl = thumbnailInfo?.thumbnailUrl ?? thumbnailUrl;
  }

  const resolved: Partial<FeedVideo> = {};
  if (!sameCid(rootCid, video.rootCid)) {
    resolved.rootCid = rootCid;
  }
  if (!playbackInfo && !thumbnailInfo) {
    return Object.keys(resolved).length > 0 ? resolved : null;
  }

  const resolvedRootCid = playbackRootCid;
  if (!sameCid(resolvedRootCid, resolved.rootCid ?? video.rootCid)) {
    resolved.rootCid = resolvedRootCid;
  }
  if (thumbnailUrl) {
    resolved.thumbnailUrl = thumbnailUrl;
  }
  if (playbackInfo?.videoPath) {
    resolved.videoPath = playbackInfo.videoPath;
  }
  if (typeof playbackInfo?.duration === 'number') {
    resolved.duration = playbackInfo.duration;
  }
  if (typeof playbackInfo?.title === 'string' && playbackInfo.title) {
    resolved.title = playbackInfo.title;
  }

  return Object.keys(resolved).length > 0 ? resolved : null;
}

async function resolveFeedVideoMedia(video: FeedVideo): Promise<void> {
  const resolutionKey = getFeedMediaResolutionKey(video);
  if (!resolutionKey) return;
  if (!shouldResolveFeedVideoMedia(video)) return;
  if (attemptedFeedMediaKeys.has(resolutionKey) || inFlightFeedMediaKeys.has(resolutionKey)) return;

  inFlightFeedMediaKeys.add(resolutionKey);
  try {
    const resolved = await getFeedVideoResolvedMedia(video);
    if (!resolved) {
      scheduleFeedVideoMediaRetry(resolutionKey);
      return;
    }

    const nextVideo = { ...video, ...resolved };
    const nextResolutionKey = getFeedMediaResolutionKey(nextVideo) ?? resolutionKey;
    cachedFeedMediaByKey.set(resolutionKey, {
      ...cachedFeedMediaByKey.get(resolutionKey),
      ...resolved,
    });
    if (nextResolutionKey !== resolutionKey) {
      cachedFeedMediaByKey.set(nextResolutionKey, {
        ...cachedFeedMediaByKey.get(nextResolutionKey),
        ...resolved,
      });
    }
    const retryTimer = feedMediaRetryTimers.get(resolutionKey) ?? feedMediaRetryTimers.get(nextResolutionKey);
    if (retryTimer) {
      clearTimeout(retryTimer);
      feedMediaRetryTimers.delete(resolutionKey);
      feedMediaRetryTimers.delete(nextResolutionKey);
    }
    feedMediaRetryCounts.delete(resolutionKey);
    feedMediaRetryCounts.delete(nextResolutionKey);

    feedStore.update((videos) => {
      let changed = false;
      const nextVideos = videos.map((candidate) => {
        const candidateKey = getFeedMediaResolutionKey(candidate);
        if (candidateKey !== resolutionKey && candidateKey !== nextResolutionKey) {
          return candidate;
        }

        const nextTitle = resolved.title ?? candidate.title;
        const nextDuration = resolved.duration ?? candidate.duration;
        const nextThumbnailUrl = resolved.thumbnailUrl ?? candidate.thumbnailUrl;
        const nextVideoPath = resolved.videoPath ?? candidate.videoPath;
        const nextRootCid = resolved.rootCid ?? candidate.rootCid;

        if (
          nextTitle === candidate.title &&
          nextDuration === candidate.duration &&
          nextThumbnailUrl === candidate.thumbnailUrl &&
          nextVideoPath === candidate.videoPath &&
          sameCid(nextRootCid, candidate.rootCid)
        ) {
          return candidate;
        }

        changed = true;
        return {
          ...candidate,
          title: nextTitle,
          duration: nextDuration,
          thumbnailUrl: nextThumbnailUrl,
          videoPath: nextVideoPath,
          rootCid: nextRootCid,
        };
      });

      return changed ? nextVideos : videos;
    });

    if (!shouldResolveFeedVideoMedia(nextVideo)) {
      attemptedFeedMediaKeys.add(resolutionKey);
      attemptedFeedMediaKeys.add(nextResolutionKey);
    } else {
      scheduleFeedVideoMediaRetry(nextResolutionKey);
    }
  } finally {
    inFlightFeedMediaKeys.delete(resolutionKey);
  }
}

function scheduleFeedVideoMediaRetry(resolutionKey: string): void {
  if (feedMediaRetryTimers.has(resolutionKey)) return;

  const attempt = (feedMediaRetryCounts.get(resolutionKey) ?? 0) + 1;
  if (attempt > FEED_MEDIA_RESOLUTION_MAX_RETRIES) {
    return;
  }

  feedMediaRetryCounts.set(resolutionKey, attempt);
  const delayMs = 250 * (2 ** (attempt - 1));
  const timer = setTimeout(() => {
    feedMediaRetryTimers.delete(resolutionKey);
    const current = get(feedStore).find((video) => getFeedMediaResolutionKey(video) === resolutionKey);
    if (!current) return;
    if (!shouldResolveFeedVideoMedia(current)) return;
    void resolveFeedVideoMedia(current);
  }, delayMs);

  feedMediaRetryTimers.set(resolutionKey, timer);
}

function queueFeedVideoMediaResolution(videos: FeedVideo[]): void {
  const pending = videos.filter((video) => {
    const resolutionKey = getFeedMediaResolutionKey(video);
    return !!resolutionKey
      && shouldResolveFeedVideoMedia(video)
      && !feedMediaRetryTimers.has(resolutionKey)
      && !attemptedFeedMediaKeys.has(resolutionKey)
      && !inFlightFeedMediaKeys.has(resolutionKey);
  });

  if (pending.length === 0) return;

  for (const video of pending) {
    void resolveFeedVideoMedia(video);
  }
}

export function setFeedVideos(videos: FeedVideo[]): void {
  const hydratedVideos = applyCachedFeedMedia(videos);
  feedStore.set(hydratedVideos);
  queueFeedVideoMediaResolution(hydratedVideos);
}

// Track if we're already fetching to avoid duplicate requests
let isFetching = false;
let hasInitialFetch = false;

// Cache for fallback follows (bootstrap user's follows)
let fallbackFollowsCache: string[] | null = null;

let lastPubkey: string | null = null;
nostrStore.subscribe((state: NostrState) => {
  if (state.pubkey === lastPubkey) return;
  lastPubkey = state.pubkey;
  resetFeedFetchState();
  resetFeedMediaResolution();
  setFeedVideos([]);
  log('reset:pubkey', { pubkey: state.pubkey });
});

async function waitForRelayConnection(timeoutMs: number): Promise<number> {
  const initial = getNostrState().connectedRelays;
  if (initial > 0) return initial;

  return new Promise<number>((resolve) => {
    let done = false;
    const unsub = nostrStore.subscribe((state: NostrState) => {
      if (done) return;
      if (state.connectedRelays > 0) {
        done = true;
        unsub();
        resolve(state.connectedRelays);
      }
    });

    setTimeout(() => {
      if (done) return;
      done = true;
      unsub();
      resolve(0);
    }, timeoutMs);
  });
}

function scheduleRelayRetry(): void {
  if (retryOnRelayScheduled) return;
  retryOnRelayScheduled = true;
  log('retry:relay:wait');

  const unsub = nostrStore.subscribe((state: NostrState) => {
    if (state.connectedRelays > 0) {
      unsub();
      retryOnRelayScheduled = false;
      log('retry:relay:trigger', { connectedRelays: state.connectedRelays });
      void fetchFeedVideos();
    }
  });

  setTimeout(() => {
    if (!retryOnRelayScheduled) return;
    retryOnRelayScheduled = false;
    unsub();
  }, RELAY_RETRY_TIMEOUT_MS);
}

/**
 * Fetch fallback follows from the bootstrap user (for users with few/no follows)
 */
async function fetchFallbackFollows(): Promise<string[]> {
  if (fallbackFollowsCache) {
    return fallbackFollowsCache;
  }

  return new Promise<string[]>((resolve) => {
    let latestTimestamp = 0;
    let latestEventId: string | null = null;
    const sub = ndk.subscribe(
      { kinds: [3], authors: [DEFAULT_BOOTSTRAP_PUBKEY] },
      { closeOnEose: true }
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

      fallbackFollowsCache = followPubkeys;
    });

    sub.on('eose', () => {
      resolve(fallbackFollowsCache || []);
    });

    setTimeout(() => resolve(fallbackFollowsCache || []), 5000);
  });
}

/**
 * Get effective follows list with fallback (shared logic with VideoHome)
 * Optimized for speed - uses short timeout and parallel fallback fetch
 */
export async function getEffectiveFollows(userPubkey: string): Promise<string[]> {
  let follows: string[] = [];

  // Try synchronous sources first (instant)
  const cachedFollows = getFollowsSync(userPubkey);
  if (cachedFollows && cachedFollows.follows.length >= MIN_FOLLOWS_THRESHOLD) {
    return cachedFollows.follows;
  }
  if (cachedFollows) follows = cachedFollows.follows;

  const socialGraphFollows = getSocialGraphFollows(userPubkey);
  if (socialGraphFollows && socialGraphFollows.size >= MIN_FOLLOWS_THRESHOLD) {
    return Array.from(socialGraphFollows);
  }
  if (socialGraphFollows && socialGraphFollows.size > follows.length) {
    follows = Array.from(socialGraphFollows);
  }

  // Start fetching fallback in parallel (don't await yet)
  const fallbackPromise = fetchFallbackFollows();

  // Try async sources with SHORT timeout (1.5s max)
  if (follows.length < MIN_FOLLOWS_THRESHOLD) {
    const adapter = getWorkerAdapter();
    if (adapter) {
      try {
        const workerFollows = await Promise.race([
          adapter.getFollows(userPubkey),
          new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 500))
        ]);
        if (workerFollows && workerFollows.length > follows.length) {
          follows = workerFollows;
        }
      } catch {
        // Worker not ready
      }
    }
  }

  // If still not enough, try followsStore with very short timeout
  if (follows.length < MIN_FOLLOWS_THRESHOLD) {
    const followsStore = createFollowsStore(userPubkey);
    const storeFollows = await new Promise<string[]>((resolve) => {
      let resolved = false;
      let unsubscribe: (() => void) | null = null;
      const cleanup = () => {
        if (unsubscribe) unsubscribe();
        followsStore.destroy();
      };
      // Short timeout - 1 second max
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; cleanup(); resolve([]); }
      }, 1000);
      unsubscribe = followsStore.subscribe((value) => {
        if (value && value.follows.length > 0 && !resolved) {
          resolved = true; clearTimeout(timeout); cleanup();
          resolve(value.follows);
        }
      });
    });
    if (storeFollows.length > follows.length) {
      follows = storeFollows;
    }
  }

  // Use fallback if user has few/no follows
  if (follows.length < MIN_FOLLOWS_THRESHOLD) {
    const fallbackFollows = await fallbackPromise;
    const combined = new Set(follows);
    combined.add(DEFAULT_BOOTSTRAP_PUBKEY);
    if (getAppType() === 'video') {
      for (const pk of DEFAULT_VIDEO_FEED_PUBKEYS) {
        combined.add(pk);
      }
      if (DEFAULT_VIDEO_FEED_PUBKEYS.length > 0) {
        log('follows:video-seed', { count: DEFAULT_VIDEO_FEED_PUBKEYS.length });
      }
    }
    for (const pk of fallbackFollows) {
      combined.add(pk);
    }
    return Array.from(combined);
  }

  return follows;
}

/**
 * Fetch feed videos - same logic as VideoHome (kind:30078 hashtree events)
 */
export async function fetchFeedVideos(): Promise<void> {
  if (isFetching || hasInitialFetch) {
    log('skip:state', { isFetching, hasInitialFetch });
    return;
  }

  if (get(feedStore).length > 0) {
    log('skip:existing');
    return;
  }

  isFetching = true;
  log('fetch:start');

  try {
    if (!getWorkerAdapter()) {
      log('fetch:worker-not-ready');
      const readyAdapter = await waitForWorkerAdapter(10000);
      if (!readyAdapter) {
        log('fetch:worker-timeout');
      }
    }

    const statePubkey = getNostrState().pubkey;
    const usingBootstrap = !statePubkey;
    const userPubkey = statePubkey ?? DEFAULT_BOOTSTRAP_PUBKEY;
    if (usingBootstrap) {
      log('fetch:bootstrap', { pubkey: userPubkey });
    }

    const connectedRelays = await waitForRelayConnection(RELAY_WAIT_TIMEOUT_MS);
    log('relays:connected', { connectedRelays });

    const follows = await getEffectiveFollows(userPubkey);
    log('follows:effective', { count: follows.length });

    const authors = Array.from(new Set([userPubkey, ...follows]));
    const seenVideos = new Map<string, FeedVideo>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let eventCount = 0;

    const flushVideos = (reason: string) => {
      const videos = orderFeedWithInterleaving(Array.from(seenVideos.values()));
      log('flush', { reason, count: videos.length });
      if (videos.length > 0) {
        setFeedVideos(videos);
        hasInitialFetch = true;
        clearEmptyFeedRetry();
      }
    };

    const scheduleFlush = (reason: string) => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushVideos(reason);
      }, 250);
    };

    // Fetch kind:30078 hashtree events (same as VideoHome)
    const sub = ndk.subscribe({
      kinds: [30078],
      authors: authors.slice(0, 500),
      '#l': ['hashtree'],
    }, { closeOnEose: true });

    activeSubscription?.stop();
    activeSubscription = sub;

    await new Promise<void>((resolve) => {
      sub.on('event', (event) => {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];
        if (!dTag || !dTag.startsWith('videos/')) return;

        const ownerPubkey = event.pubkey;
        const ownerNpub = pubkeyToNpub(ownerPubkey);
        if (!ownerNpub) return;
        const key = `${ownerNpub}/${dTag}`;

        const hashTag = event.tags.find(t => t[0] === 'hash')?.[1];
        const createdAt = event.created_at || 0;
        if (!hashTag) {
          recordDeletedVideo(ownerNpub, dTag, createdAt);
          const existing = seenVideos.get(key);
          if (existing && (existing.timestamp || 0) <= createdAt) {
            seenVideos.delete(key);
            scheduleFlush('delete');
          }
          return;
        }

        // Only public videos
        const hasEncryptedKey = event.tags.some(t => t[0] === 'encryptedKey');
        const hasSelfEncryptedKey = event.tags.some(t => t[0] === 'selfEncryptedKey');
        if (hasEncryptedKey || hasSelfEncryptedKey) return;

        const deletedAt = getDeletedVideoTimestamp(ownerNpub, dTag);
        if (deletedAt && deletedAt >= createdAt) return;
        if (deletedAt && deletedAt < createdAt) {
          clearDeletedVideo(ownerNpub, dTag);
        }

        const existing = seenVideos.get(key);
        if (existing && (existing.timestamp || 0) >= createdAt) return;

        const keyTag = event.tags.find(t => t[0] === 'key')?.[1];
        const hash = fromHex(hashTag);
        const encKey = keyTag ? fromHex(keyTag) : undefined;

        seenVideos.set(key, {
          href: `#/${ownerNpub}/${encodeURIComponent(dTag)}`,
          title: dTag.slice(7),
          ownerPubkey,
          ownerNpub,
          treeName: dTag,
          timestamp: createdAt,
          rootCid: { hash, key: encKey },
        });
        scheduleFlush('event');
        eventCount += 1;
        if (eventCount <= 3) {
          log('event', { dTag, ownerNpub, createdAt });
        }
      });

      sub.on('eose', () => {
        log('eose');
        resolve();
      });
      setTimeout(resolve, 5000);
    });

    // Order with interleaving to prevent one owner from dominating the feed
    const videos = orderFeedWithInterleaving(Array.from(seenVideos.values()));

    log('complete', { count: videos.length });

    if (videos.length > 0) {
      setFeedVideos(videos);
      hasInitialFetch = true;
      clearEmptyFeedRetry();
    }

    if (videos.length === 0) {
      if (connectedRelays === 0) {
        log('retry:relay:none');
        scheduleRelayRetry();
      } else {
        scheduleEmptyFeedRetry('empty-feed');
      }
    }
  } finally {
    isFetching = false;
  }
}

export function resetFeedFetchState(): void {
  activeSubscription?.stop();
  activeSubscription = null;
  clearEmptyFeedRetry();
  hasInitialFetch = false;
  isFetching = false;
  resetFeedMediaResolution();
}
