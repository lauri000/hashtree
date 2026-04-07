import type { CID, HashTree } from '@hashtree/core';
import { parseHashtreeRootEvent, type NostrEvent } from '@hashtree/nostr';
import { SimplePool, nip19 } from 'nostr-tools';

export const DEFAULT_ROOT_RESOLVE_TIMEOUT_MS = 15_000;
export const DEFAULT_ROOT_RESOLVE_SETTLE_MS = 500;

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

type ParsedRootPath = {
  exactTreeName: string;
  treeName: string;
  subPath: string[];
  watchTreeNames: string[];
};

type RootRecord = {
  event: NostrEvent;
  cid: CID;
};

export interface RootWatchHandle {
  initialCid: CID | null;
  close(): Promise<void>;
}

function decodeNpub(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
      return null;
    }
    return decoded.data;
  } catch {
    return null;
  }
}

function parseRootLookupPath(path?: string): ParsedRootPath {
  const pathSegments = splitPathSegments(path);
  const exactTreeName = pathSegments.join('/') || 'public';
  const treeName = pathSegments[0] || 'public';
  const subPath = pathSegments.slice(1);
  const watchTreeNames = Array.from(new Set([exactTreeName, treeName]));

  return {
    exactTreeName,
    treeName,
    subPath,
    watchTreeNames,
  };
}

function cidKey(cid: CID | null): string {
  if (!cid) return '';
  const keyHex = cid.key ? Array.from(cid.key).map((byte) => byte.toString(16).padStart(2, '0')).join('') : '';
  const hashHex = Array.from(cid.hash).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return keyHex ? `${hashHex}:${keyHex}` : hashHex;
}

function updateLatestRecord(current: RootRecord | null, event: NostrEvent, cid: CID): RootRecord | null {
  if (current && compareReplaceableEvents(event, current.event) >= 0) {
    return null;
  }

  return { event, cid };
}

async function resolvePreferredCid(
  tree: Pick<HashTree, 'resolvePath'> | null,
  exactRecord: RootRecord | null,
  treeRecord: RootRecord | null,
  subPath: string[],
): Promise<CID | null> {
  if (exactRecord) {
    return exactRecord.cid;
  }

  if (!treeRecord) {
    return null;
  }

  if (subPath.length === 0) {
    return treeRecord.cid;
  }

  if (!tree) {
    throw new Error('Tree not initialized');
  }

  return (await tree.resolvePath(treeRecord.cid, subPath))?.cid ?? null;
}

async function queryLatestTreeRoot(
  relays: string[],
  npub: string,
  treeName: string,
  timeoutMs: number,
  settleMs: number,
): Promise<RootRecord | null> {
  const pubkey = decodeNpub(npub);
  if (!pubkey) {
    return null;
  }

  const pool = new SimplePool();

  return await new Promise<RootRecord | null>((resolve) => {
    let closed = false;
    let latestRecord: RootRecord | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let subscription: { close(reason?: string): void | Promise<void> } | null = null;

    const finish = (record: RootRecord | null): void => {
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
          resolve(record);
        });
    };

    const scheduleFinish = (): void => {
      if (!latestRecord) {
        return;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      settleTimer = setTimeout(() => {
        finish(latestRecord);
      }, settleMs);
    };

    timeoutId = setTimeout(() => {
      finish(latestRecord);
    }, timeoutMs);

    subscription = pool.subscribeMany(relays, {
      kinds: [30078],
      authors: [pubkey],
      '#d': [treeName],
      limit: MAX_TREE_ROOT_EVENTS,
    }, {
      maxWait: timeoutMs,
      onevent(event) {
        const parsed = parseHashtreeRootEvent(event as Parameters<typeof parseHashtreeRootEvent>[0]);
        if (!parsed || parsed.treeName !== treeName) {
          return;
        }

        const nextRecord = updateLatestRecord(latestRecord, event, parsed.rootCid);
        if (nextRecord) {
          latestRecord = nextRecord;
          scheduleFinish();
        }
      },
      oneose() {
        // Ignore faster relay EOSE notifications. A slower relay may still deliver a newer replaceable event.
      },
      onclose() {
        // Ignore relay close notifications and let settle/timeout windows decide.
      },
    });
  });
}

export async function watchRootPathFromRelays(
  tree: Pick<HashTree, 'resolvePath'> | null,
  relays: string[] | undefined,
  npub: string,
  path: string | undefined,
  onUpdate: (cid: CID | null) => void | Promise<void>,
  timeoutMs: number = DEFAULT_ROOT_RESOLVE_TIMEOUT_MS,
  settleMs: number = DEFAULT_ROOT_RESOLVE_SETTLE_MS,
): Promise<RootWatchHandle> {
  const relayList = withUniqueRelays(relays);
  const pubkey = decodeNpub(npub);
  if (!pubkey) {
    return {
      initialCid: null,
      async close() {
        // no-op
      },
    };
  }

  const { exactTreeName, treeName, subPath, watchTreeNames } = parseRootLookupPath(path);
  const pool = new SimplePool();
  let exactRecord: RootRecord | null = null;
  let treeRecord: RootRecord | null = null;
  let subscription: { close(reason?: string): void | Promise<void> } | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let resolveTicket = 0;
  let currentCidKey: string | null = null;
  let initialResolved = false;
  let closed = false;

  const close = async (): Promise<void> => {
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

    await Promise.resolve(subscription?.close('resolved')).catch(() => undefined);
    try {
      pool.close(relayList);
    } catch {
      // Ignore close errors.
    }
    try {
      pool.destroy();
    } catch {
      // Ignore destroy errors.
    }
  };

  const emitCurrent = async (mode: 'initial' | 'update'): Promise<CID | null> => {
    const ticket = ++resolveTicket;
    const cid = await resolvePreferredCid(tree, exactRecord, treeRecord, subPath);
    if (closed || ticket !== resolveTicket) {
      return cid;
    }

    const nextKey = cidKey(cid);
    if (mode === 'initial') {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      initialResolved = true;
      currentCidKey = nextKey;
      return cid;
    }

    if (currentCidKey === nextKey) {
      return cid;
    }

    currentCidKey = nextKey;
    await onUpdate(cid);
    return cid;
  };

  const initialCid = await new Promise<CID | null>((resolve) => {
    const settleInitial = (): void => {
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      settleTimer = setTimeout(() => {
        void emitCurrent('initial').then(resolve);
      }, settleMs);
    };

    timeoutId = setTimeout(() => {
      void emitCurrent('initial').then(resolve);
    }, timeoutMs);

    subscription = pool.subscribeMany(relayList, {
      kinds: [30078],
      authors: [pubkey],
      '#d': watchTreeNames,
      limit: Math.max(MAX_TREE_ROOT_EVENTS, watchTreeNames.length * MAX_TREE_ROOT_EVENTS),
    }, {
      maxWait: timeoutMs,
      onevent(event) {
        const parsed = parseHashtreeRootEvent(event as Parameters<typeof parseHashtreeRootEvent>[0]);
        if (!parsed) {
          return;
        }

        let updated = false;
        if (parsed.treeName === exactTreeName) {
          const nextRecord = updateLatestRecord(exactRecord, event, parsed.rootCid);
          if (nextRecord) {
            exactRecord = nextRecord;
            updated = true;
          }
        }

        if (parsed.treeName === treeName) {
          const nextRecord = updateLatestRecord(treeRecord, event, parsed.rootCid);
          if (nextRecord) {
            treeRecord = nextRecord;
            updated = true;
          }
        }

        if (!updated) {
          return;
        }

        if (!initialResolved) {
          settleInitial();
          return;
        }

        void emitCurrent('update');
      },
      oneose() {
        // Ignore faster relay EOSE notifications. The live watch keeps listening.
      },
      onclose() {
        // Ignore relay close notifications. Other relays may still be active.
      },
    });
  });

  return {
    initialCid,
    close,
  };
}

export async function resolveRootPathFromRelays(
  tree: Pick<HashTree, 'resolvePath'> | null,
  relays: string[] | undefined,
  npub: string,
  path?: string,
  timeoutMs: number = DEFAULT_ROOT_RESOLVE_TIMEOUT_MS,
  settleMs: number = DEFAULT_ROOT_RESOLVE_SETTLE_MS,
): Promise<CID | null> {
  const relayList = withUniqueRelays(relays);
  const { exactTreeName, treeName, subPath } = parseRootLookupPath(path);

  const exactRoot = await queryLatestTreeRoot(relayList, npub, exactTreeName, timeoutMs, settleMs);
  if (exactRoot) {
    return exactRoot.cid;
  }

  if (subPath.length === 0) {
    return null;
  }

  const root = await queryLatestTreeRoot(relayList, npub, treeName, timeoutMs, settleMs);
  if (!root) {
    return null;
  }

  return resolvePreferredCid(tree, null, root, subPath);
}
