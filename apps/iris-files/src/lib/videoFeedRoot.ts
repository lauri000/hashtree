import { cid, fromHex, type CID } from '@hashtree/core';
import { getLocalRootCache, getLocalRootKey } from '../treeRootCache';
import { getInjectedHtreeServerUrl } from './nativeHtree';

const DEFAULT_TREE_ROOT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://temp.iris.to',
  'wss://offchain.pub',
];

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

/**
 * Resolve the tree root for a feed item.
 *
 * Feed items coming from reactions/comments may not carry `rootCid` directly,
 * but the current tree root is often already available in the local cache.
 */
export function resolveFeedVideoRootCid(video: FeedVideoRootSource): CID | null {
  if (video.rootCid) return video.rootCid;
  if (!video.ownerNpub || !video.treeName) return null;

  const hash = getLocalRootCache(video.ownerNpub, video.treeName);
  if (!hash) return null;

  const key = getLocalRootKey(video.ownerNpub, video.treeName);
  return cid(hash, key);
}

export async function resolveFeedVideoRootCidAsync(
  video: FeedVideoRootSource,
  timeoutMs = 3000,
): Promise<CID | null> {
  const cached = resolveFeedVideoRootCid(video);
  if (cached) return cached;
  if (!video.ownerNpub || !video.treeName) return null;

  try {
    const { getRefResolver } = await import('../refResolver');
    const resolver = getRefResolver();
    const resolved = await withTimeout(
      resolver.resolve(`${video.ownerNpub}/${video.treeName}`),
      timeoutMs,
    );
    if (resolved) return resolved;
  } catch {
    // Fall through to direct Nostr tree-event lookup.
  }

  try {
    const { ndk, npubToPubkey } = await import('../nostr');
    const ownerPubkey = npubToPubkey(video.ownerNpub);
    if (!isHexPubkey(ownerPubkey)) return null;

    const event = await withTimeout(ndk.fetchEvent({
      kinds: [30078],
      authors: [ownerPubkey],
      '#d': [video.treeName],
    }, { closeOnEose: true }), timeoutMs);
    if (event) {
      const hashHex = event.tags.find((tag) => tag[0] === 'hash')?.[1];
      if (hashHex) {
        const keyHex = event.tags.find((tag) => tag[0] === 'key')?.[1];
        return cid(fromHex(hashHex), keyHex ? fromHex(keyHex) : undefined);
      }
    }
  } catch {
    // Fall through to raw relay query.
  }

  if (getInjectedHtreeServerUrl()) {
    return null;
  }

  try {
    const { npubToPubkey } = await import('../nostr');
    const ownerPubkey = npubToPubkey(video.ownerNpub);
    if (!isHexPubkey(ownerPubkey)) return null;

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
      if (!events || events.size === 0) return null;

      const latestEvent = Array.from(events).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
      if (!latestEvent) return null;

      const hashHex = latestEvent.tags.find((tag) => tag[0] === 'hash')?.[1];
      if (!hashHex) return null;

      const keyHex = latestEvent.tags.find((tag) => tag[0] === 'key')?.[1];
      return cid(fromHex(hashHex), keyHex ? fromHex(keyHex) : undefined);
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

  return null;
}
