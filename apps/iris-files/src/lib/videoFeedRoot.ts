import { cid, fromHex, type CID } from '@hashtree/core';
import { getLocalRootCache, getLocalRootKey } from '../treeRootCache';

type FeedVideoRootSource = {
  rootCid?: CID | null;
  ownerNpub?: string | null;
  treeName?: string | null;
};

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
    const resolved = await Promise.race([
      resolver.resolve(`${video.ownerNpub}/${video.treeName}`),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (resolved) return resolved;
  } catch {
    // Fall through to direct Nostr tree-event lookup.
  }

  try {
    const { ndk, npubToPubkey } = await import('../nostr');
    const ownerPubkey = npubToPubkey(video.ownerNpub);
    if (!ownerPubkey) return null;

    const event = await ndk.fetchEvent({
      kinds: [30078],
      authors: [ownerPubkey],
      '#d': [video.treeName],
    }, { closeOnEose: true });
    if (!event) return null;

    const hashHex = event.tags.find((tag) => tag[0] === 'hash')?.[1];
    if (!hashHex) return null;

    const keyHex = event.tags.find((tag) => tag[0] === 'key')?.[1];
    return cid(fromHex(hashHex), keyHex ? fromHex(keyHex) : undefined);
  } catch {
    return null;
  }
}
