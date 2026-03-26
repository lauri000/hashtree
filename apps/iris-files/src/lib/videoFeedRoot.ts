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

interface ResolvedTreeRoot {
  cid: CID;
  updatedAt?: number;
}

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

function firstNonNull<T>(promises: Array<Promise<T | null>>): Promise<T | null> {
  if (promises.length === 0) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let pending = promises.length;
    let settled = false;

    const settleNull = () => {
      pending -= 1;
      if (!settled && pending === 0) {
        settled = true;
        resolve(null);
      }
    };

    for (const promise of promises) {
      promise
        .then((value) => {
          if (settled) return;
          if (value) {
            settled = true;
            resolve(value);
            return;
          }
          settleNull();
        })
        .catch(() => {
          if (settled) return;
          settleNull();
        });
    }
  });
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
    let resolvedOwnerPubkey: string | null = null;
    try {
      const { npubToPubkey } = await import('../nostr');
      resolvedOwnerPubkey = npubToPubkey(video.ownerNpub);
    } catch {
      resolvedOwnerPubkey = null;
    }

    const lookupTasks: Array<Promise<ResolvedTreeRoot | null>> = [
      (async (): Promise<ResolvedTreeRoot | null> => {
        try {
          const { getRefResolver } = await import('../refResolver');
          const resolver = getRefResolver();
          const resolved = await withTimeout(
            resolver.resolve(`${video.ownerNpub}/${video.treeName}`),
            timeoutMs,
          );
          return resolved ? { cid: resolved } : null;
        } catch {
          return null;
        }
      })(),
    ];

    if (isHexPubkey(resolvedOwnerPubkey)) {
      lookupTasks.push(
        (async (): Promise<ResolvedTreeRoot | null> => {
          try {
            const { ndk } = await import('../nostr');
            const event = await withTimeout(ndk.fetchEvent({
              kinds: [30078],
              authors: [resolvedOwnerPubkey],
              '#d': [video.treeName],
            }, { closeOnEose: true }), timeoutMs);
            const hashHex = event?.tags.find((tag) => tag[0] === 'hash')?.[1];
            if (!hashHex) {
              return null;
            }
            const keyHex = event.tags.find((tag) => tag[0] === 'key')?.[1];
            return {
              cid: cid(fromHex(hashHex), keyHex ? fromHex(keyHex) : undefined),
              updatedAt: event.created_at,
            };
          } catch {
            return null;
          }
        })(),
        (async (): Promise<ResolvedTreeRoot | null> => {
          try {
            const { SimplePool } = await import('nostr-tools');
            const pool = new SimplePool();
            try {
              const events = await withTimeout(
                pool.querySync(
                  DEFAULT_TREE_ROOT_RELAYS,
                  {
                    kinds: [30078],
                    authors: [resolvedOwnerPubkey],
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
              const hashHex = latestEvent?.tags.find((tag) => tag[0] === 'hash')?.[1];
              if (!hashHex) {
                return null;
              }
              const keyHex = latestEvent.tags.find((tag) => tag[0] === 'key')?.[1];
              return {
                cid: cid(fromHex(hashHex), keyHex ? fromHex(keyHex) : undefined),
                updatedAt: latestEvent.created_at,
              };
            } finally {
              try {
                pool.close(DEFAULT_TREE_ROOT_RELAYS);
              } catch {}
              try {
                pool.destroy();
              } catch {}
            }
          } catch {
            return null;
          }
        })(),
      );
    }

    try {
      const resolved = await firstNonNull(lookupTasks);
      if (resolved) {
        await cacheResolvedFeedTreeRoot(
          video.ownerNpub!,
          video.treeName!,
          resolved.cid,
          resolved.updatedAt,
        );
        return resolved.cid;
      }
    } catch {
      if (!fallbackRootCid) {
        await cacheResolvedFeedTreeRoot(video.ownerNpub!, video.treeName!, null);
      }
      return fallbackRootCid;
    }

    if (!fallbackRootCid) {
      await cacheResolvedFeedTreeRoot(video.ownerNpub!, video.treeName!, null);
    }
    return fallbackRootCid;
  })();

  inFlightFeedRootResolutions.set(cacheKey, lookup);
  try {
    return await lookup;
  } finally {
    inFlightFeedRootResolutions.delete(cacheKey);
  }
}
