import { cid, fromHex, type CID } from '@hashtree/core';
import { DEFAULT_TREE_ROOT_RELAYS } from './defaultRelays';
import { getLocalRootCache, getLocalRootKey } from '../treeRootCache';
const FEED_ROOT_CACHE_TTL_MS = 30_000;
const FEED_ROOT_MISS_CACHE_TTL_MS = 5_000;

const feedRootResolutionCache = new Map<string, {
  cid: CID | null;
  expiresAt: number;
  authoritative: boolean;
}>();
const inFlightFeedRootResolutions = new Map<string, Promise<CID | null>>();

interface ResolvedTreeRoot {
  cid: CID;
  updatedAt?: number;
  authoritative?: boolean;
}

interface ResolveFeedVideoRootOptions {
  requireAuthoritative?: boolean;
  authoritativeGraceMs?: number;
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
  const authoritative = typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0;
  const cacheKey = getFeedRootCacheKey(npub, treeName);
  if (!resolved || authoritative) {
    feedRootResolutionCache.set(cacheKey, {
      cid: resolved,
      expiresAt: Date.now() + (resolved ? FEED_ROOT_CACHE_TTL_MS : FEED_ROOT_MISS_CACHE_TTL_MS),
      authoritative,
    });
  } else {
    // Speculative resolver answers should not stick around and outrank the
    // authoritative replaceable-event path on subsequent loads.
    feedRootResolutionCache.delete(cacheKey);
  }
  if (!resolved) {
    return;
  }

  // Feed-root lookups can return a speculative local/ref-resolver answer that does
  // not carry event freshness. Keep that as a route-local seed, but do not
  // promote it into the shared mutable-root caches with a synthetic "now"
  // timestamp or it can outrank the actual latest tree root.
  if (!authoritative) {
    return;
  }

  try {
    const { updateSubscriptionCache } = await import('../stores/treeRoot');
    updateSubscriptionCache(`${npub}/${treeName}`, resolved.hash, resolved.key, {
      updatedAt,
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
  options: ResolveFeedVideoRootOptions = {},
): Promise<CID | null> {
  const fallbackRootCid = resolveFeedVideoRootCid(video) ?? video.rootCid ?? null;
  const cached = resolveFeedVideoRootCid(video);
  if (cached && !options.requireAuthoritative) return cached;
  if (!video.ownerNpub || !video.treeName) return fallbackRootCid;

  const cacheKey = getFeedRootCacheKey(video.ownerNpub, video.treeName);
  const cachedResult = feedRootResolutionCache.get(cacheKey);
  if (cachedResult && cachedResult.expiresAt > Date.now()) {
    if (!options.requireAuthoritative || cachedResult.authoritative) {
      return cachedResult.cid;
    }
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

    const resolverTask = (async (): Promise<ResolvedTreeRoot | null> => {
      try {
        const { getRefResolver } = await import('../refResolver');
        const resolver = getRefResolver();
        const resolved = await withTimeout(
          resolver.resolve(`${video.ownerNpub}/${video.treeName}`),
          timeoutMs,
        );
        return resolved ? { cid: resolved, authoritative: false } : null;
      } catch {
        return null;
      }
    })();

    const lookupTasks: Array<Promise<ResolvedTreeRoot | null>> = [resolverTask];
    const authoritativeTasks: Array<Promise<ResolvedTreeRoot | null>> = [];

    if (isHexPubkey(resolvedOwnerPubkey)) {
      const ndkTask = (async (): Promise<ResolvedTreeRoot | null> => {
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
            authoritative: true,
          };
        } catch {
          return null;
        }
      })();
      const relayTask = (async (): Promise<ResolvedTreeRoot | null> => {
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
              authoritative: true,
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
      })();
      lookupTasks.push(ndkTask, relayTask);
      authoritativeTasks.push(ndkTask, relayTask);
    }

    if (options.requireAuthoritative && authoritativeTasks.length > 0) {
      const authoritativeGraceMs = Math.min(timeoutMs, Math.max(250, options.authoritativeGraceMs ?? 1500));
      const earlyAuthoritative = (await Promise.all(
        authoritativeTasks.map((task) => withTimeout(task, authoritativeGraceMs)),
      )).filter((result): result is ResolvedTreeRoot => !!result);

      const freshestAuthoritative = earlyAuthoritative
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      if (freshestAuthoritative) {
        await cacheResolvedFeedTreeRoot(
          video.ownerNpub!,
          video.treeName!,
          freshestAuthoritative.cid,
          freshestAuthoritative.updatedAt,
        );
        return freshestAuthoritative.cid;
      }

      const remainingMs = Math.max(0, timeoutMs - authoritativeGraceMs);
      const speculativeResolved = await withTimeout(resolverTask, remainingMs);
      if (speculativeResolved) {
        await cacheResolvedFeedTreeRoot(
          video.ownerNpub!,
          video.treeName!,
          speculativeResolved.cid,
          speculativeResolved.updatedAt,
        );
        return speculativeResolved.cid;
      }
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
