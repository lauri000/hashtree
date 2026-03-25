import { cid, fromHex, toHex, type CID } from '@hashtree/core';
import type { NDKEvent } from 'ndk';
import { SimplePool } from 'nostr-tools';
import { npubToPubkey, ndk } from '../nostr';
import { getTree } from '../store';
import { logHtreeDebug } from './htreeDebug';
import { findPlayableMediaEntry } from './playableMedia';
import { readDirectPlayableMediaFileName } from './directPlayableRoot';

const ROOT_READ_TIMEOUT_MS = 8000;
const ROOT_HISTORY_FETCH_TIMEOUT_MS = 3000;
const MAX_ROOT_HISTORY_CANDIDATES = 6;
const FALLBACK_CACHE_TTL_MS = 10000;
const NO_FALLBACK_CACHE_TTL_MS = 10000;
const MAX_PLAYLIST_CHILD_PROBES = 12;
const READABLE_ROOT_HISTORY_CONCURRENCY = 2;
const DEFAULT_HISTORY_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://temp.iris.to',
  'wss://offchain.pub',
];

const inFlightReadableRoots = new Map<string, Promise<CID | null>>();
const readableRootCache = new Map<string, { cid: CID | null; expiresAt: number }>();
const readableRootHistoryWaiters: Array<() => void> = [];
let activeBackgroundReadableRootHistoryLookups = 0;
let activeForegroundReadableRootHistoryLookups = 0;
const TIMEOUT = Symbol('timeout');

function wakeReadableRootHistoryWaiter(): void {
  if (activeForegroundReadableRootHistoryLookups > 0) {
    return;
  }
  if (activeBackgroundReadableRootHistoryLookups >= READABLE_ROOT_HISTORY_CONCURRENCY) {
    return;
  }
  const next = readableRootHistoryWaiters.shift();
  next?.();
}

async function withReadableRootHistorySlot<T>(
  priority: 'foreground' | 'background',
  work: () => Promise<T>,
): Promise<T> {
  if (priority === 'background' && (
    activeForegroundReadableRootHistoryLookups > 0
    || activeBackgroundReadableRootHistoryLookups >= READABLE_ROOT_HISTORY_CONCURRENCY
  )) {
    await new Promise<void>((resolve) => {
      readableRootHistoryWaiters.push(resolve);
    });
  }

  if (priority === 'foreground') {
    activeForegroundReadableRootHistoryLookups += 1;
  } else {
    activeBackgroundReadableRootHistoryLookups += 1;
  }
  try {
    return await work();
  } finally {
    if (priority === 'foreground') {
      activeForegroundReadableRootHistoryLookups -= 1;
    } else {
      activeBackgroundReadableRootHistoryLookups -= 1;
    }
    wakeReadableRootHistoryWaiter();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return Promise.race([
    promise,
    new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), ms)),
  ]);
}

function hasLabel(event: Pick<NDKEvent, 'tags'>, label: string): boolean {
  return event.tags.some((tag) => tag[0] === 'l' && tag[1] === label);
}

function hasAnyLabel(event: Pick<NDKEvent, 'tags'>): boolean {
  return event.tags.some((tag) => tag[0] === 'l');
}

function sameCid(a: CID | null | undefined, b: CID | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return toHex(a.hash) === toHex(b.hash)
    && ((a.key && b.key && toHex(a.key) === toHex(b.key)) || (!a.key && !b.key));
}

function parseTreeRootCid(event: NDKEvent): CID | null {
  if (hasAnyLabel(event) && !hasLabel(event, 'hashtree')) {
    return null;
  }

  const hashHex = event.tags.find((tag) => tag[0] === 'hash')?.[1];
  if (!hashHex) return null;

  const keyHex = event.tags.find((tag) => tag[0] === 'key')?.[1];
  try {
    return cid(fromHex(hashHex), keyHex ? fromHex(keyHex) : undefined);
  } catch {
    return null;
  }
}

function getHistoryRelayUrls(): string[] {
  const relayUrls = new Set<string>(DEFAULT_HISTORY_RELAYS);
  const connected = typeof ndk.pool?.connectedRelays === 'function'
    ? ndk.pool.connectedRelays().map((relay) => relay.url)
    : [];
  for (const url of connected) {
    relayUrls.add(url);
  }
  if (typeof ndk.pool?.urls === 'function') {
    for (const url of ndk.pool.urls()) {
      relayUrls.add(url);
    }
  }
  return Array.from(relayUrls);
}

async function queryRawTreeRootEvents(pubkey: string, treeName: string): Promise<NDKEvent[] | null> {
  const relayUrls = getHistoryRelayUrls();
  if (relayUrls.length === 0) {
    return null;
  }

  const pool = new SimplePool();
  try {
    const events = await withTimeout(
      pool.querySync(relayUrls, {
        kinds: [30078],
        authors: [pubkey],
        '#d': [treeName],
        limit: MAX_ROOT_HISTORY_CANDIDATES,
      }, {
        maxWait: ROOT_HISTORY_FETCH_TIMEOUT_MS,
      }),
      ROOT_HISTORY_FETCH_TIMEOUT_MS + 500,
    );
    return events === TIMEOUT ? null : events;
  } catch {
    return null;
  } finally {
    try {
      pool.close(relayUrls);
    } catch {}
    try {
      pool.destroy();
    } catch {}
  }
}

function uniqueEvents(events: NDKEvent[]): NDKEvent[] {
  const seen = new Set<string>();
  const result: NDKEvent[] = [];
  for (const event of events) {
    const eventKey = event.id
      || `${event.created_at ?? 0}:${event.tags.find((tag) => tag[0] === 'hash')?.[1] ?? ''}`;
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    result.push(event);
  }
  return result;
}

async function isReadableVideoRoot(rootCid: CID, videoId?: string): Promise<'readable' | 'unreadable' | 'timeout'> {
  try {
    const tree = getTree();
    let targetCid = rootCid;

    if (videoId) {
      const resolved = await withTimeout(tree.resolvePath(rootCid, videoId), ROOT_READ_TIMEOUT_MS);
      if (resolved === TIMEOUT) {
        return 'timeout';
      }
      if (!resolved?.cid) {
        return 'unreadable';
      }
      targetCid = resolved.cid;
    }

    const entries = await withTimeout(tree.listDirectory(targetCid), ROOT_READ_TIMEOUT_MS);
    const directFileName = await readDirectPlayableMediaFileName(tree, targetCid, ROOT_READ_TIMEOUT_MS);
    if (directFileName) {
      return 'readable';
    }
    if (entries === TIMEOUT) {
      return 'timeout';
    }
    if (!entries || entries.length === 0) {
      return 'unreadable';
    }

    if (findPlayableMediaEntry(entries)) {
      return 'readable';
    }

    // Valid playlist roots may not have media at the root, but they should still
    // contain at least one child directory with playable media.
    if (!videoId) {
      const childCandidates = entries
        .filter((entry) => !!entry?.cid)
        .slice(0, MAX_PLAYLIST_CHILD_PROBES);
      for (const entry of childCandidates) {
        const childEntries = await withTimeout(tree.listDirectory(entry.cid), ROOT_READ_TIMEOUT_MS);
        if (childEntries === TIMEOUT) {
          return 'timeout';
        }
        if (childEntries && childEntries.length > 0 && findPlayableMediaEntry(childEntries)) {
          return 'readable';
        }
      }
    }

    return 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function getCacheKey(rootCid: CID, npub: string, treeName: string, videoId?: string): string {
  return `${npub}/${treeName}/${toHex(rootCid.hash)}:${rootCid.key ? toHex(rootCid.key) : ''}:${videoId ?? ''}`;
}

export async function resolveReadableVideoRoot(options: {
  rootCid: CID | null | undefined;
  npub: string | null | undefined;
  treeName: string | null | undefined;
  videoId?: string | null;
  priority?: 'foreground' | 'background';
}): Promise<CID | null> {
  const { rootCid, npub, treeName, videoId, priority = 'background' } = options;
  if (!rootCid || !npub || !treeName) {
    return rootCid ?? null;
  }

  const currentRootReadability = await isReadableVideoRoot(rootCid, videoId ?? undefined);
  if (currentRootReadability === 'readable') {
    logHtreeDebug('video-root:current-readable', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
    });
    return rootCid;
  }
  if (currentRootReadability === 'timeout') {
    logHtreeDebug('video-root:current-timeout', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
    });
  }

  const cacheKey = getCacheKey(rootCid, npub, treeName, videoId ?? undefined);
  const cached = readableRootCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.cid ?? rootCid;
  }
  if (cached) {
    readableRootCache.delete(cacheKey);
  }

  const existing = inFlightReadableRoots.get(cacheKey);
  if (existing) {
    return (await existing) ?? rootCid;
  }

  const lookup = withReadableRootHistorySlot(priority, async (): Promise<CID | null> => {
    const pubkey = npubToPubkey(npub);
    if (!pubkey) {
      return null;
    }

    logHtreeDebug('video-root:probe-history', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
    });

    let events: Awaited<ReturnType<typeof ndk.fetchEvents>> | null = null;
    try {
      const timedEvents = await withTimeout(
        ndk.fetchEvents({
          kinds: [30078],
          authors: [pubkey],
          '#d': [treeName],
          limit: MAX_ROOT_HISTORY_CANDIDATES,
        }),
        ROOT_HISTORY_FETCH_TIMEOUT_MS,
      );
      events = timedEvents === TIMEOUT ? null : timedEvents;
    } catch {
      return null;
    }
    if (!events) {
      events = new Set();
    }

    const sortedEvents = Array.from(events).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    for (const event of sortedEvents) {
      const candidate = parseTreeRootCid(event);
      if (!candidate || sameCid(candidate, rootCid)) {
        continue;
      }
      if ((await isReadableVideoRoot(candidate, videoId ?? undefined)) === 'readable') {
        logHtreeDebug('video-root:fallback', {
          npub,
          treeName,
          videoId: videoId ?? null,
          fromHash: toHex(rootCid.hash).slice(0, 8),
          toHash: toHex(candidate.hash).slice(0, 8),
        });
        readableRootCache.set(cacheKey, {
          cid: candidate,
          expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS,
        });
        return candidate;
      }
    }

    const rawEvents = await queryRawTreeRootEvents(pubkey, treeName);
    if (rawEvents && rawEvents.length > 0) {
      logHtreeDebug('video-root:probe-history:raw', {
        npub,
        treeName,
        videoId: videoId ?? null,
        rootHash: toHex(rootCid.hash).slice(0, 8),
        events: rawEvents.length,
      });
      const rawCandidates = uniqueEvents(rawEvents).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
      for (const event of rawCandidates) {
        const candidate = parseTreeRootCid(event);
        if (!candidate || sameCid(candidate, rootCid)) {
          continue;
        }
        if ((await isReadableVideoRoot(candidate, videoId ?? undefined)) === 'readable') {
          logHtreeDebug('video-root:fallback', {
            npub,
            treeName,
            videoId: videoId ?? null,
            fromHash: toHex(rootCid.hash).slice(0, 8),
            toHash: toHex(candidate.hash).slice(0, 8),
          });
          readableRootCache.set(cacheKey, {
            cid: candidate,
            expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS,
          });
          return candidate;
        }
      }
    }

    logHtreeDebug('video-root:no-fallback', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
    });
    readableRootCache.set(cacheKey, {
      cid: null,
      expiresAt: Date.now() + NO_FALLBACK_CACHE_TTL_MS,
    });
    return null;
  });

  inFlightReadableRoots.set(cacheKey, lookup);
  try {
    return (await lookup) ?? rootCid;
  } finally {
    inFlightReadableRoots.delete(cacheKey);
  }
}
