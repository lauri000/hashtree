import type { CID, HashTree } from '@hashtree/core';
import { parseHashtreeRootEvent, type NostrEvent } from '@hashtree/nostr';
import { SimplePool, nip19 } from 'nostr-tools';

export const DEFAULT_ROOT_RESOLVE_TIMEOUT_MS = 15_000;

const MAX_TREE_ROOT_EVENTS = 8;
const DEFAULT_ROOT_RESOLVE_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://temp.iris.to',
  'wss://offchain.pub',
];

function withUniqueRelays(relays?: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const relay of [...(relays ?? []), ...DEFAULT_ROOT_RESOLVE_RELAYS]) {
    const normalized = relay.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function safeDecodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function splitPathSegments(path?: string): string[] {
  return path
    ?.split('/')
    .filter(Boolean)
    .map(safeDecodePathSegment) ?? [];
}

function compareReplaceableEvents(left: NostrEvent, right: NostrEvent): number {
  const createdAtDiff = (right.created_at ?? 0) - (left.created_at ?? 0);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  const leftId = left.id ?? '';
  const rightId = right.id ?? '';
  return rightId.localeCompare(leftId);
}

async function queryLatestTreeRoot(
  relays: string[],
  npub: string,
  treeName: string,
  timeoutMs: number,
): Promise<CID | null> {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
    return null;
  }

  const pool = new SimplePool();

  return await new Promise<CID | null>((resolve) => {
    let closed = false;
    let latestEvent: NostrEvent | null = null;
    let latestCid: CID | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let subscription: { close(reason?: string): void | Promise<void> } | null = null;

    const finish = (cid: CID | null): void => {
      if (closed) {
        return;
      }
      closed = true;

      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      Promise.resolve(subscription?.close('resolved'))
        .catch(() => undefined)
        .finally(() => {
          try {
            pool.close(relays);
          } catch {
            // Ignore close errors.
          }
          try {
            pool.destroy();
          } catch {
            // Ignore destroy errors.
          }
          resolve(cid);
        });
    };

    const scheduleFinish = (): void => {
      if (!latestCid) {
        return;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      settleTimer = setTimeout(() => {
        finish(latestCid);
      }, 150);
    };

    timeoutId = setTimeout(() => {
      finish(latestCid);
    }, timeoutMs);

    subscription = pool.subscribeMany(relays, {
      kinds: [30078],
      authors: [decoded.data],
      '#d': [treeName],
      limit: MAX_TREE_ROOT_EVENTS,
    }, {
      maxWait: timeoutMs,
      onevent(event) {
        const parsed = parseHashtreeRootEvent(event as Parameters<typeof parseHashtreeRootEvent>[0]);
        if (!parsed || parsed.treeName !== treeName) {
          return;
        }

        if (!latestEvent || compareReplaceableEvents(event, latestEvent) < 0) {
          latestEvent = event;
          latestCid = parsed.rootCid;
          scheduleFinish();
        }
      },
      oneose() {
        finish(latestCid);
      },
      onclose() {
        finish(latestCid);
      },
    });
  });
}

export async function resolveRootPathFromRelays(
  tree: Pick<HashTree, 'resolvePath'> | null,
  relays: string[] | undefined,
  npub: string,
  path?: string,
  timeoutMs: number = DEFAULT_ROOT_RESOLVE_TIMEOUT_MS,
): Promise<CID | null> {
  const relayList = withUniqueRelays(relays);
  const pathSegments = splitPathSegments(path);
  const exactTreeName = pathSegments.join('/') || 'public';

  const exactRoot = await queryLatestTreeRoot(relayList, npub, exactTreeName, timeoutMs);
  if (exactRoot) {
    return exactRoot;
  }

  const treeName = pathSegments[0] || 'public';
  const subPath = pathSegments.slice(1);
  if (subPath.length === 0) {
    return null;
  }

  const root = await queryLatestTreeRoot(relayList, npub, treeName, timeoutMs);
  if (!root) {
    return null;
  }

  if (!tree) {
    throw new Error('Tree not initialized');
  }

  return (await tree.resolvePath(root, subPath))?.cid ?? null;
}
