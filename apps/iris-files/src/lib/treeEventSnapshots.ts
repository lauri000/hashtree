import { nip19, SimplePool } from 'nostr-tools';
import {
  decryptKeyFromLink,
  fromHex,
  nhashEncode,
  toHex,
  type CID,
} from '@hashtree/core';
import type { NDKEvent } from 'ndk';
import {
  parseHashtreeRootEvent,
  readSignedNostrEventSnapshot,
  storeSignedNostrEventSnapshot,
  type ParsedHashtreeRootEvent,
  type StoredNostrEvent,
} from '@hashtree/nostr';
import { localStore } from '../store';
import { ndk } from '../nostr';

const SNAPSHOT_FETCH_TIMEOUT_MS = 5000;
const SNAPSHOT_FETCH_LIMIT = 20;

export interface TreeEventSnapshotInfo extends ParsedHashtreeRootEvent {
  snapshotCid: CID;
  snapshotNhash: string;
  npub: string;
}

const snapshotsByTreeKey = new Map<string, TreeEventSnapshotInfo>();
const snapshotsByEventId = new Map<string, TreeEventSnapshotInfo>();
const snapshotsBySnapshotHash = new Map<string, TreeEventSnapshotInfo>();
const inFlightTreeLookups = new Map<string, Promise<TreeEventSnapshotInfo | null>>();
const inFlightSnapshotReads = new Map<string, Promise<TreeEventSnapshotInfo | null>>();
const inFlightRootSnapshotLookups = new Map<string, Promise<TreeEventSnapshotInfo | null>>();
const ROOT_SNAPSHOT_LOOKUP_TIMEOUT_MS = 20_000;
const ROOT_SNAPSHOT_LOOKUP_INTERVAL_MS = 500;

function getSnapshotHashKey(snapshotCid: CID): string {
  return toHex(snapshotCid.hash);
}

function getTreeKey(npub: string, treeName: string): string {
  return `${npub}/${treeName}`;
}

function getRootSnapshotLookupKey(npub: string, treeName: string, rootCid: CID): string {
  return `${getTreeKey(npub, treeName)}:${toHex(rootCid.hash)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function compareEvents(a: StoredNostrEvent, b: StoredNostrEvent): number {
  if (a.created_at !== b.created_at) {
    return a.created_at - b.created_at;
  }
  return a.id.localeCompare(b.id);
}

export function compareTreeEventSnapshots(a: TreeEventSnapshotInfo, b: TreeEventSnapshotInfo): number {
  return compareEvents(a.event, b.event);
}

export function isNewerTreeEventSnapshot(candidate: TreeEventSnapshotInfo, current: TreeEventSnapshotInfo): boolean {
  return compareTreeEventSnapshots(candidate, current) > 0;
}

export function snapshotMatchesRootCid(
  snapshot: TreeEventSnapshotInfo | null | undefined,
  rootCid: CID | null | undefined,
): boolean {
  if (!snapshot || !rootCid) {
    return false;
  }
  if (toHex(snapshot.rootCid.hash) !== toHex(rootCid.hash)) {
    return false;
  }
  if (snapshot.visibility !== 'public') {
    return true;
  }
  const snapshotKey = snapshot.rootCid.key ? toHex(snapshot.rootCid.key) : null;
  const rootKey = rootCid.key ? toHex(rootCid.key) : null;
  if (snapshotKey === null || rootKey === null) {
    return true;
  }
  return snapshotKey === rootKey;
}

function normalizeRawEvent(event: Pick<StoredNostrEvent, 'id' | 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content' | 'sig'>): StoredNostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };
}

function normalizeNdkEvent(event: NDKEvent): StoredNostrEvent | null {
  const raw = event.rawEvent() as Partial<StoredNostrEvent>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.pubkey !== 'string' ||
    typeof raw.created_at !== 'number' ||
    typeof raw.kind !== 'number' ||
    !Array.isArray(raw.tags) ||
    typeof raw.content !== 'string' ||
    typeof raw.sig !== 'string'
  ) {
    return null;
  }
  return normalizeRawEvent(raw as StoredNostrEvent);
}

function registerSnapshot(
  snapshot: TreeEventSnapshotInfo,
  options: { updateTreeKey?: boolean } = {},
): TreeEventSnapshotInfo {
  snapshotsByEventId.set(snapshot.event.id, snapshot);
  snapshotsBySnapshotHash.set(getSnapshotHashKey(snapshot.snapshotCid), snapshot);

  if (options.updateTreeKey !== false) {
    const treeKey = getTreeKey(snapshot.npub, snapshot.treeName);
    const existing = snapshotsByTreeKey.get(treeKey);
    if (!existing || compareEvents(existing.event, snapshot.event) <= 0) {
      snapshotsByTreeKey.set(treeKey, snapshot);
    }
  }

  return snapshot;
}

export async function cacheTreeEventSnapshot(event: StoredNostrEvent): Promise<TreeEventSnapshotInfo | null> {
  const parsed = parseHashtreeRootEvent(event);
  if (!parsed) {
    return null;
  }

  const existing = snapshotsByEventId.get(parsed.event.id);
  if (existing) {
    return registerSnapshot(existing, { updateTreeKey: true });
  }

  const snapshotCid = await storeSignedNostrEventSnapshot(localStore, parsed.event);
  const npub = nip19.npubEncode(parsed.event.pubkey);
  return registerSnapshot({
    ...parsed,
    snapshotCid,
    snapshotNhash: nhashEncode(snapshotCid),
    npub,
  }, { updateTreeKey: true });
}

export async function cacheTreeEventSnapshotFromNdkEvent(event: NDKEvent): Promise<TreeEventSnapshotInfo | null> {
  const normalized = normalizeNdkEvent(event);
  if (!normalized) return null;
  return cacheTreeEventSnapshot(normalized);
}

export function getCachedTreeEventSnapshot(npub: string | null | undefined, treeName: string | null | undefined): TreeEventSnapshotInfo | null {
  if (!npub || !treeName) return null;
  return snapshotsByTreeKey.get(getTreeKey(npub, treeName)) ?? null;
}

export async function readTreeEventSnapshot(snapshotCid: CID): Promise<TreeEventSnapshotInfo | null> {
  const hashKey = getSnapshotHashKey(snapshotCid);
  const cached = snapshotsBySnapshotHash.get(hashKey);
  if (cached) {
    return cached;
  }

  const inFlight = inFlightSnapshotReads.get(hashKey);
  if (inFlight) {
    return inFlight;
  }

  const lookup = (async (): Promise<TreeEventSnapshotInfo | null> => {
    try {
      const event = await readSignedNostrEventSnapshot(localStore, snapshotCid);
      const parsed = parseHashtreeRootEvent(event);
      if (!parsed) {
        return null;
      }
      return registerSnapshot({
        ...parsed,
        snapshotCid,
        snapshotNhash: nhashEncode(snapshotCid),
        npub: nip19.npubEncode(parsed.event.pubkey),
      }, { updateTreeKey: false });
    } catch {
      return null;
    }
  })();

  inFlightSnapshotReads.set(hashKey, lookup);
  try {
    return await lookup;
  } finally {
    inFlightSnapshotReads.delete(hashKey);
  }
}

async function fetchLatestTreeEvent(pubkey: string, treeName: string): Promise<StoredNostrEvent | null> {
  const ndkEvents = await ndk.fetchEvents({
    kinds: [30078],
    authors: [pubkey],
    '#d': [treeName],
    limit: SNAPSHOT_FETCH_LIMIT,
  }).catch(() => null);

  const candidates: StoredNostrEvent[] = [];
  for (const event of ndkEvents ?? []) {
    const normalized = normalizeNdkEvent(event);
    if (!normalized) continue;
    if (!parseHashtreeRootEvent(normalized)) continue;
    candidates.push(normalized);
  }

  if (candidates.length > 0) {
    candidates.sort(compareEvents);
    return candidates[candidates.length - 1] ?? null;
  }

  const relayUrls = typeof ndk.pool?.urls === 'function' ? ndk.pool.urls() : [];
  if (relayUrls.length === 0) {
    return null;
  }

  const pool = new SimplePool();
  try {
    const rawEvents = await pool.querySync(relayUrls, {
      kinds: [30078],
      authors: [pubkey],
      '#d': [treeName],
      limit: SNAPSHOT_FETCH_LIMIT,
    }, {
      maxWait: SNAPSHOT_FETCH_TIMEOUT_MS,
    });
    for (const raw of rawEvents) {
      const normalized = normalizeRawEvent(raw as StoredNostrEvent);
      if (!parseHashtreeRootEvent(normalized)) continue;
      candidates.push(normalized);
    }
    candidates.sort(compareEvents);
    return candidates[candidates.length - 1] ?? null;
  } catch {
    return null;
  } finally {
    try {
      pool.destroy();
    } catch {}
  }
}

async function fetchLatestTreeEventSnapshot(npub: string, treeName: string): Promise<TreeEventSnapshotInfo | null> {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') {
    return null;
  }
  const event = await fetchLatestTreeEvent(decoded.data as string, treeName);
  if (!event) {
    return null;
  }
  return cacheTreeEventSnapshot(event);
}

export async function ensureLatestTreeEventSnapshot(npub: string, treeName: string): Promise<TreeEventSnapshotInfo | null> {
  const cached = getCachedTreeEventSnapshot(npub, treeName);
  if (cached) {
    return cached;
  }

  const treeKey = getTreeKey(npub, treeName);
  const inFlight = inFlightTreeLookups.get(treeKey);
  if (inFlight) {
    return inFlight;
  }

  const lookup = (async (): Promise<TreeEventSnapshotInfo | null> => {
    try {
      return await fetchLatestTreeEventSnapshot(npub, treeName);
    } catch {
      return null;
    }
  })();

  inFlightTreeLookups.set(treeKey, lookup);
  try {
    return await lookup;
  } finally {
    inFlightTreeLookups.delete(treeKey);
  }
}

export async function ensureTreeEventSnapshotForRoot(
  npub: string,
  treeName: string,
  rootCid: CID,
): Promise<TreeEventSnapshotInfo | null> {
  const cached = getCachedTreeEventSnapshot(npub, treeName);
  if (snapshotMatchesRootCid(cached, rootCid)) {
    return cached;
  }

  const lookupKey = getRootSnapshotLookupKey(npub, treeName, rootCid);
  const inFlight = inFlightRootSnapshotLookups.get(lookupKey);
  if (inFlight) {
    return inFlight;
  }

  const lookup = (async (): Promise<TreeEventSnapshotInfo | null> => {
    const deadline = Date.now() + ROOT_SNAPSHOT_LOOKUP_TIMEOUT_MS;
    let nextFetchAt = 0;

    while (Date.now() <= deadline) {
      const nextCached = getCachedTreeEventSnapshot(npub, treeName);
      if (snapshotMatchesRootCid(nextCached, rootCid)) {
        return nextCached;
      }

      if (Date.now() >= nextFetchAt) {
        const latest = await fetchLatestTreeEventSnapshot(npub, treeName).catch(() => null);
        if (snapshotMatchesRootCid(latest, rootCid)) {
          return latest;
        }
        nextFetchAt = Date.now() + ROOT_SNAPSHOT_LOOKUP_INTERVAL_MS;
      }

      if (Date.now() + ROOT_SNAPSHOT_LOOKUP_INTERVAL_MS > deadline) {
        break;
      }
      await sleep(ROOT_SNAPSHOT_LOOKUP_INTERVAL_MS);
    }

    return null;
  })();

  inFlightRootSnapshotLookups.set(lookupKey, lookup);
  try {
    return await lookup;
  } finally {
    inFlightRootSnapshotLookups.delete(lookupKey);
  }
}

export function buildTreeEventPermalink(
  snapshot: TreeEventSnapshotInfo,
  path: string[] = [],
  linkKey?: string | null,
): string {
  const encodedPath = path.map(encodeURIComponent).join('/');
  const query = new URLSearchParams();
  query.set('snapshot', '1');
  if (linkKey) {
    query.set('k', linkKey);
  }
  const suffix = query.toString();
  return `#/${snapshot.snapshotNhash}${encodedPath ? `/${encodedPath}` : ''}${suffix ? `?${suffix}` : ''}`;
}

export function buildTreeRouteHref(
  npub: string,
  treeName: string,
  path: string[] = [],
  linkKey?: string | null,
): string {
  const encodedParts = [npub, treeName, ...path].map(encodeURIComponent).join('/');
  const query = new URLSearchParams();
  if (linkKey) {
    query.set('k', linkKey);
  }
  const suffix = query.toString();
  return `#/${encodedParts}${suffix ? `?${suffix}` : ''}`;
}

export async function buildPreferredTreeEventHref(
  npub: string,
  treeName: string,
  path: string[] = [],
  linkKey?: string | null,
): Promise<string> {
  const cached = getCachedTreeEventSnapshot(npub, treeName);
  if (cached) {
    return buildTreeEventPermalink(cached, path, linkKey);
  }
  const latest = await ensureLatestTreeEventSnapshot(npub, treeName);
  if (latest) {
    return buildTreeEventPermalink(latest, path, linkKey);
  }
  return buildTreeRouteHref(npub, treeName, path, linkKey);
}

export async function resolveSnapshotRootCid(
  snapshot: TreeEventSnapshotInfo,
  linkKey?: string | null,
): Promise<CID | null> {
  if (snapshot.visibility === 'public') {
    return snapshot.rootCid;
  }

  if (snapshot.visibility === 'link-visible' && snapshot.encryptedKey && linkKey) {
    try {
      const decryptedKey = await decryptKeyFromLink(fromHex(snapshot.encryptedKey), fromHex(linkKey));
      if (decryptedKey) {
        return { hash: snapshot.rootCid.hash, key: decryptedKey };
      }
      return null;
    } catch {
      return null;
    }
  }

  return null;
}
