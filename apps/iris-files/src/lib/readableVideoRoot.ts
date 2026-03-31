import { cid, fromHex, toHex, type CID } from '@hashtree/core';
import type { NDKEvent } from 'ndk';
import { SimplePool } from 'nostr-tools';
import { npubToPubkey, ndk } from '../nostr';
import { getTree } from '../store';
import { logHtreeDebug } from './htreeDebug';
import {
  buildSyntheticPlayableMediaFileName,
  findPlayableMediaEntry,
  isAudioMediaFileName,
  isPlayableMediaFileName,
  PREFERRED_PLAYABLE_MEDIA_FILENAMES,
} from './playableMedia';
import { readDirectPlayableMediaFileName } from './directPlayableRoot';
import { DEFAULT_HISTORY_RELAYS } from './defaultRelays';
import { getStablePathUrl } from './mediaUrl';

const ROOT_READ_TIMEOUT_MS = 8000;
const ROOT_HISTORY_FETCH_TIMEOUT_MS = 5000;
const MAX_ROOT_HISTORY_CANDIDATES = 20;
const FALLBACK_CACHE_TTL_MS = 10000;
const NO_FALLBACK_CACHE_TTL_MS = 10000;
const ROOT_HISTORY_CACHE_TTL_MS = 30000;
const EMPTY_ROOT_HISTORY_CACHE_TTL_MS = 1000;
const PREFERRED_VIDEO_ROOT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PLAYLIST_CHILD_PROBES = 12;
const THUMBNAIL_PROBE_METADATA_TIMEOUT_MS = 2500;
const THUMBNAIL_BLOB_PROBE_TIMEOUT_MS = 2500;
const PREFERRED_VIDEO_ROOT_STORAGE_KEY = 'hashtree:preferredVideoRoots';
const PRIORITY_HISTORY_RELAY_COUNT = 3;
const MIN_DISTINCT_HISTORY_EVENTS = 2;

const inFlightReadableRoots = new Map<string, Promise<CID | null>>();
const inFlightThumbnailRoots = new Map<string, Promise<CID | null>>();
const inFlightRootHistoryEvents = new Map<string, Promise<NDKEvent[]>>();
const readableRootCache = new Map<string, { cid: CID | null; expiresAt: number }>();
const thumbnailRootCache = new Map<string, { cid: CID | null; expiresAt: number }>();
const rootHistoryEventCache = new Map<string, { events: NDKEvent[]; expiresAt: number }>();
const preferredVideoRootCache = new Map<string, { cid: CID; expiresAt: number }>();
let preferredVideoRootCacheHydrated = false;
const TIMEOUT = Symbol('timeout');

function isHexPubkey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
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

type VideoRootReadability = 'video' | 'audio' | 'unreadable' | 'timeout';

interface VideoRootProfile {
  kind: VideoRootReadability;
  preference: number;
  fileName?: string;
  playableCount: number;
}

function readableKindFromFileName(fileName: string): VideoRootReadability {
  return isAudioMediaFileName(fileName) ? 'audio' : 'video';
}

function isReadableVideoKind(kind: VideoRootReadability): boolean {
  return kind === 'video' || kind === 'audio';
}

function getPlayableMediaPreference(fileName: string): number {
  const normalized = fileName.trim().toLowerCase();
  const preferredIndex = PREFERRED_PLAYABLE_MEDIA_FILENAMES.indexOf(
    normalized as (typeof PREFERRED_PLAYABLE_MEDIA_FILENAMES)[number]
  );
  if (preferredIndex !== -1) {
    return preferredIndex;
  }
  return PREFERRED_PLAYABLE_MEDIA_FILENAMES.length;
}

function createReadableProfile(fileName: string): VideoRootProfile {
  return {
    kind: readableKindFromFileName(fileName),
    preference: getPlayableMediaPreference(fileName),
    fileName,
    playableCount: 1,
  };
}

function createUnusableProfile(kind: 'unreadable' | 'timeout'): VideoRootProfile {
  return {
    kind,
    preference: Number.POSITIVE_INFINITY,
    playableCount: 0,
  };
}

function isReadableVideoProfile(profile: VideoRootProfile): boolean {
  return isReadableVideoKind(profile.kind);
}

function isBetterVideoProfile(candidate: VideoRootProfile, current: VideoRootProfile): boolean {
  if (!isReadableVideoProfile(candidate)) {
    return false;
  }
  if (!isReadableVideoProfile(current)) {
    return true;
  }
  if (candidate.preference === current.preference && candidate.playableCount < current.playableCount) {
    return true;
  }
  return candidate.preference < current.preference;
}

async function confirmFetchableVideoProfile(
  rootCid: CID,
  npub: string,
  treeName: string,
  profile: VideoRootProfile,
  priority: 'foreground' | 'background',
): Promise<VideoRootProfile> {
  if (priority !== 'foreground' || !isReadableVideoProfile(profile) || !profile.fileName) {
    return profile;
  }
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return profile;
  }

  const url = getStablePathUrl({
    rootCid,
    npub,
    treeName,
    path: profile.fileName,
  });
  if (!url) {
    return profile;
  }

  try {
    const response = await withTimeout(fetch(url, {
      headers: { Range: 'bytes=0-1023' },
      cache: 'no-store',
    }), ROOT_HISTORY_FETCH_TIMEOUT_MS);
    if (response === TIMEOUT) {
      return createUnusableProfile('timeout');
    }
    if (!response.ok) {
      return createUnusableProfile('unreadable');
    }
    const body = await withTimeout(response.arrayBuffer(), ROOT_HISTORY_FETCH_TIMEOUT_MS);
    if (body === TIMEOUT) {
      return createUnusableProfile('timeout');
    }
    if (!(body instanceof ArrayBuffer) || body.byteLength === 0) {
      return createUnusableProfile('unreadable');
    }
    return profile;
  } catch {
    return createUnusableProfile('unreadable');
  }
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
  if (!isHexPubkey(pubkey)) {
    return null;
  }
  const relayUrls = getHistoryRelayUrls();
  if (relayUrls.length === 0) {
    return null;
  }

  const fetchRelayEvents = async (relayUrl: string): Promise<NDKEvent[]> => {
    const pool = new SimplePool();
    try {
      const relayEvents = await withTimeout(
        pool.querySync([relayUrl], {
          kinds: [30078],
          authors: [pubkey],
          '#d': [treeName],
          limit: MAX_ROOT_HISTORY_CANDIDATES,
        }, {
          maxWait: ROOT_HISTORY_FETCH_TIMEOUT_MS,
        }),
        ROOT_HISTORY_FETCH_TIMEOUT_MS + 500,
      );
      return relayEvents === TIMEOUT ? [] : Array.from(relayEvents);
    } catch {
      return [];
    } finally {
      try {
        pool.close([relayUrl]);
      } catch {}
      try {
        pool.destroy();
      } catch {}
    }
  };

  try {
    const prioritizedRelays = relayUrls.slice(0, PRIORITY_HISTORY_RELAY_COUNT);
    const remainingRelays = relayUrls.slice(PRIORITY_HISTORY_RELAY_COUNT);
    const mergedEvents: NDKEvent[] = [];

    for (const relayUrl of prioritizedRelays) {
      mergedEvents.push(...await fetchRelayEvents(relayUrl));
      if (uniqueEvents(mergedEvents).length >= MIN_DISTINCT_HISTORY_EVENTS) {
        return mergedEvents;
      }
    }

    const results = await Promise.allSettled(remainingRelays.map(async (relayUrl) => {
      try {
        return await fetchRelayEvents(relayUrl);
      } catch {
        return [];
      }
    }));
    mergedEvents.push(...results.flatMap((result) => (
      result.status === 'fulfilled'
        ? result.value
        : []
    )));
    return mergedEvents;
  } catch {
    return null;
  }
}

function getHistoryCacheKey(pubkey: string, treeName: string): string {
  return `${pubkey}/${treeName}`;
}

function getPreferredVideoRootKey(npub: string, treeName: string, videoId?: string): string {
  return `${npub}/${treeName}/${videoId ?? ''}`;
}

function hydratePreferredVideoRootCache(): void {
  if (preferredVideoRootCacheHydrated || typeof window === 'undefined') return;
  preferredVideoRootCacheHydrated = true;
  try {
    const raw = window.localStorage.getItem(PREFERRED_VIDEO_ROOT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, { hash: string; key?: string; expiresAt: number }>;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value?.hash || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now()) continue;
      preferredVideoRootCache.set(key, {
        cid: cid(fromHex(value.hash), value.key ? fromHex(value.key) : undefined),
        expiresAt: value.expiresAt,
      });
    }
  } catch {
    preferredVideoRootCache.clear();
  }
}

function persistPreferredVideoRootCache(): void {
  if (typeof window === 'undefined') return;
  try {
    const data: Record<string, { hash: string; key?: string; expiresAt: number }> = {};
    for (const [key, value] of preferredVideoRootCache.entries()) {
      if (value.expiresAt <= Date.now()) continue;
      data[key] = {
        hash: toHex(value.cid.hash),
        key: value.cid.key ? toHex(value.cid.key) : undefined,
        expiresAt: value.expiresAt,
      };
    }
    window.localStorage.setItem(PREFERRED_VIDEO_ROOT_STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

function getPreferredVideoRootFromCache(
  npub: string,
  treeName: string,
  videoId?: string,
): CID | null {
  hydratePreferredVideoRootCache();
  const cacheKey = getPreferredVideoRootKey(npub, treeName, videoId);
  const cached = preferredVideoRootCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt > Date.now()) {
    return cached.cid;
  }
  preferredVideoRootCache.delete(cacheKey);
  persistPreferredVideoRootCache();
  return null;
}

function setPreferredVideoRootCache(
  npub: string,
  treeName: string,
  videoId: string | undefined,
  rootCid: CID,
): void {
  hydratePreferredVideoRootCache();
  preferredVideoRootCache.set(getPreferredVideoRootKey(npub, treeName, videoId), {
    cid: rootCid,
    expiresAt: Date.now() + PREFERRED_VIDEO_ROOT_CACHE_TTL_MS,
  });
  persistPreferredVideoRootCache();
}

function normalizeHistoricalEvents(events: Iterable<NDKEvent> | null | undefined): NDKEvent[] {
  return events ? Array.from(events) : [];
}

async function getHistoricalRootEvents(pubkey: string, treeName: string): Promise<NDKEvent[]> {
  const cacheKey = getHistoryCacheKey(pubkey, treeName);
  const cached = rootHistoryEventCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.events;
  }
  if (cached) {
    rootHistoryEventCache.delete(cacheKey);
  }

  const existing = inFlightRootHistoryEvents.get(cacheKey);
  if (existing) {
    return await existing;
  }

  const lookup = (async (): Promise<NDKEvent[]> => {
    const [ndkEventsResult, rawEventsResult] = await Promise.allSettled([
      (async (): Promise<Iterable<NDKEvent> | null> => {
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
          return timedEvents === TIMEOUT ? null : timedEvents;
        } catch {
          return null;
        }
      })(),
      queryRawTreeRootEvents(pubkey, treeName),
    ]);

    const ndkEvents = ndkEventsResult.status === 'fulfilled' ? ndkEventsResult.value : null;
    const rawEvents = rawEventsResult.status === 'fulfilled' ? rawEventsResult.value : null;
    const merged = uniqueEvents([
      ...normalizeHistoricalEvents(ndkEvents),
      ...normalizeHistoricalEvents(rawEvents),
    ]).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

    rootHistoryEventCache.set(cacheKey, {
      events: merged,
      expiresAt: Date.now() + (merged.length > 0 ? ROOT_HISTORY_CACHE_TTL_MS : EMPTY_ROOT_HISTORY_CACHE_TTL_MS),
    });
    return merged;
  })();

  inFlightRootHistoryEvents.set(cacheKey, lookup);
  try {
    return await lookup;
  } finally {
    inFlightRootHistoryEvents.delete(cacheKey);
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

async function probePlayableEntryProfile(
  tree: ReturnType<typeof getTree>,
  entry: { name: string; cid?: CID },
): Promise<VideoRootProfile> {
  const fallbackProfile = createReadableProfile(entry.name);
  if (!entry.cid) {
    return fallbackProfile;
  }

  const bytes = await withTimeout(tree.readFileRange(entry.cid, 0, 64), ROOT_READ_TIMEOUT_MS);
  if (bytes === TIMEOUT) {
    return createUnusableProfile('timeout');
  }
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return createUnusableProfile('unreadable');
  }

  const syntheticFileName = buildSyntheticPlayableMediaFileName(bytes);
  return createReadableProfile(syntheticFileName ?? entry.name);
}

async function getDirectoryPlayableProfile(
  tree: ReturnType<typeof getTree>,
  entries: Array<{ name: string; cid?: CID }>,
): Promise<VideoRootProfile> {
  const playableEntries = entries
    .filter((entry) => isPlayableMediaFileName(entry.name))
    .sort((a, b) => getPlayableMediaPreference(a.name) - getPlayableMediaPreference(b.name));
  if (playableEntries.length === 0) {
    return createUnusableProfile('unreadable');
  }

  let sawTimeout = false;
  for (const entry of playableEntries) {
    const profile = await probePlayableEntryProfile(tree, entry);
    if (profile.kind === 'timeout') {
      sawTimeout = true;
      continue;
    }
    if (isReadableVideoProfile(profile)) {
      return {
        ...profile,
        playableCount: playableEntries.length,
      };
    }
  }

  return sawTimeout ? createUnusableProfile('timeout') : createUnusableProfile('unreadable');
}

function createDirectoryOnlyPlayableProfile(
  entries: Array<{ name: string }>,
): VideoRootProfile {
  const playableEntries = entries
    .filter((entry) => isPlayableMediaFileName(entry.name))
    .sort((a, b) => getPlayableMediaPreference(a.name) - getPlayableMediaPreference(b.name));
  if (playableEntries.length === 0) {
    return createUnusableProfile('unreadable');
  }
  return {
    kind: readableKindFromFileName(playableEntries[0].name),
    preference: getPlayableMediaPreference(playableEntries[0].name),
    fileName: playableEntries[0].name,
    playableCount: playableEntries.length,
  };
}

async function getReadableVideoRootProfile(rootCid: CID, videoId?: string): Promise<VideoRootProfile> {
  try {
    const tree = getTree();
    let targetCid = rootCid;

    if (videoId) {
      const resolved = await withTimeout(tree.resolvePath(rootCid, videoId), ROOT_READ_TIMEOUT_MS);
      if (resolved === TIMEOUT) {
        return createUnusableProfile('timeout');
      }
      if (!resolved?.cid) {
        return createUnusableProfile('unreadable');
      }
      targetCid = resolved.cid;
    }

    const [entries, directFileName] = await Promise.all([
      withTimeout(tree.listDirectory(targetCid), ROOT_READ_TIMEOUT_MS),
      readDirectPlayableMediaFileName(tree, targetCid, ROOT_READ_TIMEOUT_MS),
    ]);
    if (directFileName) {
      return createReadableProfile(directFileName);
    }
    if (entries === TIMEOUT) {
      return createUnusableProfile('timeout');
    }
    if (!entries || entries.length === 0) {
      return createUnusableProfile('unreadable');
    }

    const playableProfile = await getDirectoryPlayableProfile(tree, entries);
    if (isReadableVideoProfile(playableProfile)) {
      return playableProfile;
    }

    // Valid playlist roots may not have media at the root, but they should still
    // contain at least one child directory with playable media.
    if (!videoId) {
      let bestChildProfile = createUnusableProfile('unreadable');
      let sawTimeout = false;
      const childCandidates = entries
        .filter((entry) => !!entry?.cid)
        .slice(0, MAX_PLAYLIST_CHILD_PROBES);
      for (const entry of childCandidates) {
        const [childEntries, childDirectFileName] = await Promise.all([
          withTimeout(tree.listDirectory(entry.cid), ROOT_READ_TIMEOUT_MS),
          readDirectPlayableMediaFileName(tree, entry.cid, ROOT_READ_TIMEOUT_MS),
        ]);
        let childProfile = createUnusableProfile('unreadable');
        if (childDirectFileName) {
          childProfile = createReadableProfile(childDirectFileName);
        } else if (childEntries === TIMEOUT) {
          sawTimeout = true;
          childProfile = createUnusableProfile('timeout');
        } else if (childEntries && childEntries.length > 0) {
          childProfile = await getDirectoryPlayableProfile(tree, childEntries);
          if (childProfile.kind === 'timeout') {
            sawTimeout = true;
          }
        }
        if (isBetterVideoProfile(childProfile, bestChildProfile)) {
          bestChildProfile = childProfile;
          if (bestChildProfile.preference === 0) {
            return bestChildProfile;
          }
        }
      }
      if (isReadableVideoProfile(bestChildProfile)) {
        return bestChildProfile;
      }
      if (sawTimeout) {
        return createUnusableProfile('timeout');
      }
    }

    return createUnusableProfile('unreadable');
  } catch {
    return createUnusableProfile('unreadable');
  }
}

async function getOptimisticReadableVideoRootProfile(rootCid: CID, videoId?: string): Promise<VideoRootProfile> {
  try {
    const tree = getTree();
    let targetCid = rootCid;

    if (videoId) {
      const resolved = await withTimeout(tree.resolvePath(rootCid, videoId), ROOT_READ_TIMEOUT_MS);
      if (resolved === TIMEOUT) {
        return createUnusableProfile('timeout');
      }
      if (!resolved?.cid) {
        return createUnusableProfile('unreadable');
      }
      targetCid = resolved.cid;
    }

    const [entries, directFileName] = await Promise.all([
      withTimeout(tree.listDirectory(targetCid), ROOT_READ_TIMEOUT_MS),
      readDirectPlayableMediaFileName(tree, targetCid, ROOT_READ_TIMEOUT_MS),
    ]);
    if (directFileName) {
      return createReadableProfile(directFileName);
    }
    if (entries === TIMEOUT) {
      return createUnusableProfile('timeout');
    }
    if (!entries || entries.length === 0) {
      return createUnusableProfile('unreadable');
    }
    return createDirectoryOnlyPlayableProfile(entries);
  } catch {
    return createUnusableProfile('unreadable');
  }
}

async function isReadableVideoRoot(rootCid: CID, videoId?: string): Promise<'readable' | 'unreadable' | 'timeout'> {
  const profile = await getReadableVideoRootProfile(rootCid, videoId);
  if (profile.kind === 'timeout') {
    return 'timeout';
  }
  return isReadableVideoProfile(profile) ? 'readable' : 'unreadable';
}

function getCacheKey(rootCid: CID | null | undefined, npub: string, treeName: string, videoId?: string): string {
  return `${npub}/${treeName}/${rootCid ? toHex(rootCid.hash) : 'no-root'}:${rootCid?.key ? toHex(rootCid.key) : ''}:${videoId ?? ''}`;
}

function getThumbnailCacheKey(rootCid: CID, npub: string, treeName: string, videoId?: string): string {
  return `thumbnail:${getCacheKey(rootCid, npub, treeName, videoId)}`;
}

function findThumbnailEntry(
  entries: Array<{ name: string; cid?: CID }>,
): { name: string; cid?: CID } | null {
  const preferred = ['thumbnail.jpg', 'thumbnail.webp', 'thumbnail.png', 'thumbnail.jpeg'];
  for (const name of preferred) {
    const match = entries.find((entry) => entry.name === name);
    if (match) {
      return match;
    }
  }
  return entries.find((entry) => (
    entry.name.endsWith('.jpg')
    || entry.name.endsWith('.jpeg')
    || entry.name.endsWith('.png')
    || entry.name.endsWith('.webp')
  )) ?? null;
}

async function thumbnailEntryIsReadable(entry: { cid?: CID } | null): Promise<boolean | typeof TIMEOUT> {
  if (!entry?.cid) {
    return true;
  }
  const tree = getTree();
  const bytes = await withTimeout(
    tree.readFileRange(entry.cid, 0, 64),
    THUMBNAIL_BLOB_PROBE_TIMEOUT_MS,
  );
  if (bytes === TIMEOUT) {
    return TIMEOUT;
  }
  return !!bytes && bytes.length > 0;
}

async function directoryHasThumbnailEvidence(
  entries: Array<{ name: string; cid?: CID; meta?: Record<string, unknown> }>,
): Promise<'thumbnail' | 'missing' | 'timeout'> {
  const thumbnailEntry = findThumbnailEntry(entries);
  if (thumbnailEntry) {
    const readable = await thumbnailEntryIsReadable(thumbnailEntry);
    if (readable === TIMEOUT) {
      return 'timeout';
    }
    if (readable) {
      return 'thumbnail';
    }
  }

  const videoEntry = findPlayableMediaEntry(entries);
  const videoThumbnail = videoEntry?.meta && typeof videoEntry.meta.thumbnail === 'string'
    ? videoEntry.meta.thumbnail.trim()
    : '';
  if (videoThumbnail) {
    return 'thumbnail';
  }

  const tree = getTree();
  for (const metadataName of ['metadata.json', 'info.json']) {
    const metadataEntry = entries.find((entry) => entry.name === metadataName);
    if (!metadataEntry?.cid) continue;
    const metadataData = await withTimeout(
      tree.readFile(metadataEntry.cid),
      THUMBNAIL_PROBE_METADATA_TIMEOUT_MS,
    );
    if (metadataData === TIMEOUT) {
      return 'timeout';
    }
    if (!metadataData) continue;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(metadataData));
      if (typeof parsed.thumbnail === 'string' && parsed.thumbnail.trim()) {
        return 'thumbnail';
      }
    } catch {
      // Ignore malformed metadata and continue probing.
    }
  }

  return 'missing';
}

async function hasDiscoverableThumbnailRoot(
  rootCid: CID,
  videoId?: string,
): Promise<'thumbnail' | 'missing' | 'timeout'> {
  const tree = getTree();
  let targetCid = rootCid;

  if (videoId) {
    const resolved = await withTimeout(tree.resolvePath(rootCid, videoId), ROOT_READ_TIMEOUT_MS);
    if (resolved === TIMEOUT) {
      return 'timeout';
    }
    if (!resolved?.cid) {
      return 'missing';
    }
    targetCid = resolved.cid;
  }

  const entries = await withTimeout(tree.listDirectory(targetCid), ROOT_READ_TIMEOUT_MS);
  if (entries === TIMEOUT) {
    return 'timeout';
  }
  if (!entries || entries.length === 0) {
    return 'missing';
  }

  const directThumbnail = await directoryHasThumbnailEvidence(entries);
  if (directThumbnail !== 'missing') {
    return directThumbnail;
  }

  if (videoId || findPlayableMediaEntry(entries)) {
    return 'missing';
  }

  let sawTimeout = false;
  const childCandidates = entries
    .filter((entry) => !!entry?.cid)
    .slice(0, MAX_PLAYLIST_CHILD_PROBES);
  for (const entry of childCandidates) {
    const childEntries = await withTimeout(tree.listDirectory(entry.cid), ROOT_READ_TIMEOUT_MS);
    if (childEntries === TIMEOUT) {
      sawTimeout = true;
      continue;
    }
    if (!childEntries || childEntries.length === 0) {
      continue;
    }
    const childThumbnail = await directoryHasThumbnailEvidence(childEntries);
    if (childThumbnail === 'thumbnail') {
      return 'thumbnail';
    }
    if (childThumbnail === 'timeout') {
      sawTimeout = true;
    }
  }

  return sawTimeout ? 'timeout' : 'missing';
}

async function queryHistoricalRootCandidate(
  options: {
    rootCid: CID;
    npub: string;
    treeName: string;
    videoId?: string | null;
    priority: 'foreground' | 'background';
    logSuffix: string;
  },
  predicate: (candidate: CID) => Promise<boolean>,
): Promise<CID | null> {
  const { rootCid, npub, treeName, videoId, priority, logSuffix } = options;
  const pubkey = npubToPubkey(npub);
  if (!isHexPubkey(pubkey)) {
    return null;
  }

  logHtreeDebug(`video-root:${logSuffix}:probe-history`, {
    npub,
    treeName,
    videoId: videoId ?? null,
    rootHash: toHex(rootCid.hash).slice(0, 8),
  });

  const events = await getHistoricalRootEvents(pubkey, treeName);
  if (events.length > 0) {
    logHtreeDebug(`video-root:${logSuffix}:probe-history:merged`, {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
      events: events.length,
      priority,
    });
  }

  for (const event of events) {
    const candidate = parseTreeRootCid(event);
    if (!candidate || sameCid(candidate, rootCid)) {
      continue;
    }
    if (await predicate(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function queryHistoricalPreferredVideoRoot(options: {
  rootCid: CID | null | undefined;
  npub: string;
  treeName: string;
  videoId?: string | null;
  priority: 'foreground' | 'background';
  currentProfile: VideoRootProfile;
}): Promise<CID | null> {
  const { rootCid, npub, treeName, videoId, priority, currentProfile } = options;
  const pubkey = npubToPubkey(npub);
  if (!isHexPubkey(pubkey)) {
    return null;
  }

  logHtreeDebug('video-root:readable:probe-history', {
    npub,
    treeName,
    videoId: videoId ?? null,
    rootHash: rootCid ? toHex(rootCid.hash).slice(0, 8) : null,
  });

  const events = await getHistoricalRootEvents(pubkey, treeName);
  if (events.length > 0) {
    logHtreeDebug('video-root:readable:probe-history:merged', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: rootCid ? toHex(rootCid.hash).slice(0, 8) : null,
      events: events.length,
      priority,
    });
  }

  let bestCandidate: CID | null = null;
  let bestProfile = currentProfile;
  for (const event of events) {
    const candidate = parseTreeRootCid(event);
    if (!candidate || sameCid(candidate, rootCid)) {
      continue;
    }

    const candidateProfile = await confirmFetchableVideoProfile(
      candidate,
      npub,
      treeName,
      await getReadableVideoRootProfile(candidate, videoId ?? undefined),
      priority,
    );
    if (isBetterVideoProfile(candidateProfile, bestProfile)) {
      bestCandidate = candidate;
      bestProfile = candidateProfile;
      if (bestProfile.preference === 0) {
        break;
      }
    }
  }

  return bestCandidate;
}

export async function resolveReadableVideoRoot(options: {
  rootCid: CID | null | undefined;
  npub: string | null | undefined;
  treeName: string | null | undefined;
  videoId?: string | null;
  priority?: 'foreground' | 'background';
}): Promise<CID | null> {
  const { rootCid, npub, treeName, videoId, priority = 'background' } = options;
  if (!npub || !treeName) {
    return rootCid ?? null;
  }

  const currentRootProfile = rootCid
    ? await getReadableVideoRootProfile(rootCid, videoId ?? undefined)
    : createUnusableProfile('unreadable');
  const optimisticCurrentRootProfile = rootCid && currentRootProfile.kind === 'unreadable'
    ? await getOptimisticReadableVideoRootProfile(rootCid, videoId ?? undefined)
    : currentRootProfile;
  if (
    rootCid
    && isReadableVideoProfile(optimisticCurrentRootProfile)
    && optimisticCurrentRootProfile.preference === 0
    && optimisticCurrentRootProfile.playableCount <= 1
    && priority !== 'foreground'
  ) {
    logHtreeDebug('video-root:current-readable', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
      kind: optimisticCurrentRootProfile.kind,
      preference: optimisticCurrentRootProfile.preference,
    });
    setPreferredVideoRootCache(npub, treeName, videoId ?? undefined, rootCid);
    return rootCid;
  }
  const confirmedCurrentRootProfile = rootCid
    ? await confirmFetchableVideoProfile(
        rootCid,
        npub,
        treeName,
        optimisticCurrentRootProfile,
        priority,
      )
    : currentRootProfile;
  const preferredCachedRoot = getPreferredVideoRootFromCache(npub, treeName, videoId ?? undefined);
  if (preferredCachedRoot && !sameCid(preferredCachedRoot, rootCid)) {
    const preferredCachedProfile = await confirmFetchableVideoProfile(
      preferredCachedRoot,
      npub,
      treeName,
      await getReadableVideoRootProfile(preferredCachedRoot, videoId ?? undefined),
      priority,
    );
    if (isBetterVideoProfile(preferredCachedProfile, confirmedCurrentRootProfile)) {
      readableRootCache.set(getCacheKey(rootCid, npub, treeName, videoId ?? undefined), {
        cid: preferredCachedRoot,
        expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS,
      });
      return preferredCachedRoot;
    }
  }
  if (rootCid && confirmedCurrentRootProfile.kind === 'timeout') {
    logHtreeDebug('video-root:current-timeout', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
    });
  }
  if (rootCid && isReadableVideoProfile(confirmedCurrentRootProfile)) {
    logHtreeDebug('video-root:current-readable', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
      kind: confirmedCurrentRootProfile.kind,
      preference: confirmedCurrentRootProfile.preference,
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

  const lookup = queryHistoricalPreferredVideoRoot({
    rootCid,
    npub,
    treeName,
    videoId,
    priority,
    currentProfile: confirmedCurrentRootProfile,
  })
    .then((candidate) => {
      if (candidate) {
        logHtreeDebug('video-root:fallback', {
          npub,
          treeName,
          videoId: videoId ?? null,
          fromHash: rootCid ? toHex(rootCid.hash).slice(0, 8) : null,
          toHash: toHex(candidate.hash).slice(0, 8),
        });
        setPreferredVideoRootCache(npub, treeName, videoId ?? undefined, candidate);
        readableRootCache.set(cacheKey, {
          cid: candidate,
          expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS,
        });
        return candidate;
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
    const resolved = (await lookup) ?? rootCid;
    if (resolved && sameCid(resolved, rootCid) && isReadableVideoProfile(confirmedCurrentRootProfile)) {
      setPreferredVideoRootCache(npub, treeName, videoId ?? undefined, resolved);
    }
    return resolved;
  } finally {
    inFlightReadableRoots.delete(cacheKey);
  }
}

export async function resolveReadableThumbnailRoot(options: {
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

  const currentThumbnailStatus = await hasDiscoverableThumbnailRoot(rootCid, videoId ?? undefined);
  if (currentThumbnailStatus === 'thumbnail') {
    logHtreeDebug('video-root:thumbnail-current', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
    });
    return rootCid;
  }
  if (currentThumbnailStatus === 'timeout') {
    logHtreeDebug('video-root:thumbnail-current-timeout', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
    });
  }

  const cacheKey = getThumbnailCacheKey(rootCid, npub, treeName, videoId ?? undefined);
  const cached = thumbnailRootCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.cid ?? rootCid;
  }
  if (cached) {
    thumbnailRootCache.delete(cacheKey);
  }

  const existing = inFlightThumbnailRoots.get(cacheKey);
  if (existing) {
    return (await existing) ?? rootCid;
  }

  const lookup = queryHistoricalRootCandidate({
    rootCid,
    npub,
    treeName,
    videoId,
    priority,
    logSuffix: 'thumbnail',
  }, async (candidate) => {
    if ((await isReadableVideoRoot(candidate, videoId ?? undefined)) !== 'readable') {
      return false;
    }
    return (await hasDiscoverableThumbnailRoot(candidate, videoId ?? undefined)) === 'thumbnail';
  }).then((candidate) => {
    if (candidate) {
      logHtreeDebug('video-root:thumbnail-fallback', {
        npub,
        treeName,
        videoId: videoId ?? null,
        fromHash: toHex(rootCid.hash).slice(0, 8),
        toHash: toHex(candidate.hash).slice(0, 8),
      });
      thumbnailRootCache.set(cacheKey, {
        cid: candidate,
        expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS,
      });
      return candidate;
    }

    logHtreeDebug('video-root:thumbnail-no-fallback', {
      npub,
      treeName,
      videoId: videoId ?? null,
      rootHash: toHex(rootCid.hash).slice(0, 8),
    });
    thumbnailRootCache.set(cacheKey, {
      cid: null,
      expiresAt: Date.now() + NO_FALLBACK_CACHE_TTL_MS,
    });
    return null;
  });

  inFlightThumbnailRoots.set(cacheKey, lookup);
  try {
    return (await lookup) ?? rootCid;
  } finally {
    inFlightThumbnailRoots.delete(cacheKey);
  }
}
