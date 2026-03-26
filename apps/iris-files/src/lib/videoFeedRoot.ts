import { cid, fromHex, type CID } from '@hashtree/core';
import { getLocalRootCache, getLocalRootKey } from '../treeRootCache';

const DEFAULT_TREE_ROOT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://temp.iris.to',
  'wss://offchain.pub',
];
const FEED_ROOT_CACHE_TTL_MS = 30_000;
const FEED_ROOT_MISS_CACHE_TTL_MS = 5_000;

const feedRootResolutionCache = new Map<string, { cid: CID | null; expiresAt: number }>();
const inFlightFeedRootResolutions = new Map<string, Promise<CID | null>>();

type FeedVideoRootSource = {
  rootCid?: CID | null;
  ownerNpub?: string | null;
  treeName?: string | null;
};

function isHexPubkey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

function getFeedRootCacheKey(npub: string, treeName: string): string {
  return `${npub}/${treeName}`;
}

async function cacheResolvedFeedTreeRoot(
  npub: string,
  treeName: string,
  resolved: CID | null,
  updatedAt?: number,
): Promise<void> {
  feedRootResolutionCache.set(getFeedRootCacheKey(npub, treeName), {
    cid: resolved,
    expiresAt: Date.now() + (resolved ? FEED_ROOT_CACHE_TTL_MS : FEED_ROOT_MISS_CACHE_TTL_MS),
  });
  if (!resolved) {
    return;
  }

  try {
    const { updateSubscriptionCache } = await import('../stores/treeRoot');
    updateSubscriptionCache(`${npub}/${treeName}`, resolved.hash, resolved.key, {
      updatedAt: updatedAt ?? Math.floor(Date.now() / 1000),
      visibility: 'public',
    });
  } catch {
    // Ignore cache-persist failures; callers still get the resolved root.
  }
}

/**
 * Resolve the tree root for a feed item.
 *
 * Feed items coming from reactions/comments may not carry `rootCid` directly,
 * but the current tree root is often already available in the local cache.
 */
export function resolveFeedVideoRootCid(video: FeedVideoRootSource): CID | null {
  if (!video.ownerNpub || !video.treeName) {
    return video.rootCid ?? null;
  }

  const hash = getLocalRootCache(video.ownerNpub, video.treeName);
  if (!hash) return video.rootCid ?? null;

  const key = getLocalRootKey(video.ownerNpub, video.treeName);
  return cid(hash, key);
}

export async function resolveFeedVideoRootCidAsync(
  video: FeedVideoRootSource,
  timeoutMs = 8000,
): Promise<CID | null> {
  const fallbackRootCid = video.rootCid ?? null;
  const cached = resolveFeedVideoRootCid(video);
  if (cached) return cached;
  if (!video.ownerNpub || !video.treeName) return fallbackRootCid;

  const cacheKey = getFeedRootCacheKey(video.ownerNpub, video.treeName);
  const cachedResult = feedRootResolutionCache.get(cacheKey);
  if (cachedResult && cachedResult.expiresAt > Date.now()) {
    return cachedResult.cid;
  }
  if (cachedResult) {
    feedRootResolutionCache.delete(cacheKey);
  }

  const inFlight = inFlightFeedRootResolutions.get(cacheKey);
  if (inFlight) {
    return await inFlight;
  }

  const lookup = (async (): Promise<CID | null> => {
    try {
      const { getRefResolver } = await import('../refResolver');
      const resolver = getRefResolver();
      const resolved = await withTimeout(
        resolver.resolve(`${video.ownerNpub}/${video.treeName}`),
        timeoutMs,
      );
      if (resolved) {
        await cacheResolvedFeedTreeRoot(video.ownerNpub!, video.treeName!, resolved);
        return resolved;
      }
    } catch {
      // Fall through to direct Nostr tree-event lookup.
    }

    try {
      const { ndk, npubToPubkey } = await import('../nostr');
      const ownerPubkey = npubToPubkey(video.ownerNpub);
      if (!isHexPubkey(ownerPubkey)) {
        if (!fallbackRootCid) {
          await cacheResolvedFeedTreeRoot(video.ownerNpub!, video.treeName!, null);
        }
        return fallbackRootCid;
      }

      const event = await withTimeout(ndk.fetchEvent({
        kinds: [30078],
        authors: [ownerPubkey],
        '#d': [video.treeName],
      }, { closeOnEose: true }), timeoutMs);
      if (event) {
        const hashHex = event.tags.find((tag) => tag[0] === 'hash')?.[1];
        if (hashHex) {
          const keyHex = event.tags.find((tag) => tag[0] === 'key')?.[1];
          const resolved = cid(fromHex(hashHex), keyHex ? fromHex(keyHex) : undefined);
          await cacheResolvedFeedTreeRoot(video.ownerNpub!, video.treeName!, resolved, event.created_at);
          return resolved;
        }
      }
    } catch {
      // Fall through to raw relay query.
    }

    try {
      const { npubToPubkey } = await import('../nostr');
      const ownerPubkey = npubToPubkey(video.ownerNpub);
      if (!isHexPubkey(ownerPubkey)) {
        if (!fallbackRootCid) {
          await cacheResolvedFeedTreeRoot(video.ownerNpub!, video.treeName!, null);
        }
        return fallbackRootCid;
      }

      const { SimplePool } = await import('nostr-tools');
      const pool = new SimplePool();
      try {
        const events = await withTimeout(
          pool.querySync(
            DEFAULT_TREE_ROOT_RELAYS,
            {
              kinds: [30078],
              authors: [ownerPubkey],
              '#d': [video.treeName],
              limit: 4,
            },
            { maxWait: timeoutMs },
          ),
          timeoutMs + 500,
        );
        const sortedEvents = events
          ? Array.from(events).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
          : [];
        const latestEvent = sortedEvents[0];
        if (!latestEvent) {
          if (!fallbackRootCid) {
            await cacheResolvedFeedTreeRoot(video.ownerNpub!, video.treeName!, null);
          }
          return fallbackRootCid;
        }

        const hashHex = latestEvent.tags.find((tag) => tag[0] === 'hash')?.[1];
        if (!hashHex) {
          if (!fallbackRootCid) {
            await cacheResolvedFeedTreeRoot(video.ownerNpub!, video.treeName!, null);
          }
          return fallbackRootCid;
        }

        const keyHex = latestEvent.tags.find((tag) => tag[0] === 'key')?.[1];
        const resolved = cid(fromHex(hashHex), keyHex ? fromHex(keyHex) : undefined);
        await cacheResolvedFeedTreeRoot(video.ownerNpub!, video.treeName!, resolved, latestEvent.created_at);
        return resolved;
      } finally {
        try {
          pool.close(DEFAULT_TREE_ROOT_RELAYS);
        } catch {}
        try {
          pool.destroy();
        } catch {}
      }
    } catch {
      if (!fallbackRootCid) {
        await cacheResolvedFeedTreeRoot(video.ownerNpub!, video.treeName!, null);
      }
      return fallbackRootCid;
    }
  })();

  inFlightFeedRootResolutions.set(cacheKey, lookup);
  try {
    return await lookup;
  } finally {
    inFlightFeedRootResolutions.delete(cacheKey);
  }
}
