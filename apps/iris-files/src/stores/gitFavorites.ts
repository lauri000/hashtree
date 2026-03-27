import { writable } from 'svelte/store';
import { nip19 } from 'nostr-tools';
import { NDKEvent, type NostrEvent } from '../nostr';
import { ndk, nostrStore } from '../nostr';
import { buildRepoAddress } from '../nip34';
import { LRUCache } from '../utils/lruCache';
import { KeyedEventEmitter } from '../utils/keyedEventEmitter';
import { KIND_BOOKMARK_LIST } from '../utils/constants';
import { extractFavoriteRepoRefs, type FavoriteRepoRef } from '../lib/gitFavorites';

export interface FavoriteRepos {
  pubkey: string;
  repos: FavoriteRepoRef[];
  updatedAt: number;
}

const favoritesCache = new LRUCache<string, FavoriteRepos>(100);
const favoritesEmitter = new KeyedEventEmitter<string, FavoriteRepos>();
const activeSubscriptions = new Map<string, { stop: () => void }>();
const bookmarkEventCache = new Map<string, NDKEvent>();

let lastFavoriteTimestamp = 0;

function normalizePubkey(pubkey?: string): string {
  if (!pubkey) {
    return '';
  }

  if (!pubkey.startsWith('npub1')) {
    return pubkey;
  }

  try {
    const decoded = nip19.decode(pubkey);
    return decoded.data as string;
  } catch {
    return '';
  }
}

function setFavoritesFromEvent(event: NDKEvent): void {
  const favoriteRepos: FavoriteRepos = {
    pubkey: event.pubkey,
    repos: extractFavoriteRepoRefs(event.tags),
    updatedAt: event.created_at || 0,
  };

  bookmarkEventCache.set(event.pubkey, event);
  favoritesCache.set(event.pubkey, favoriteRepos);
  favoritesEmitter.notify(event.pubkey, favoriteRepos);
}

function fetchFavoriteRepos(pubkey: string): void {
  if (!pubkey || pubkey.length !== 64 || activeSubscriptions.has(pubkey)) {
    return;
  }

  let latestTimestamp = favoritesCache.get(pubkey)?.updatedAt || 0;

  const sub = ndk.subscribe(
    { kinds: [KIND_BOOKMARK_LIST], authors: [pubkey] },
    { closeOnEose: false },
  );

  sub.on('event', (event: NDKEvent) => {
    const eventTimestamp = event.created_at || 0;
    if (eventTimestamp <= latestTimestamp) {
      return;
    }

    latestTimestamp = eventTimestamp;
    setFavoritesFromEvent(event);
  });

  activeSubscriptions.set(pubkey, { stop: () => sub.stop() });
}

async function fetchLatestBookmarkListEvent(pubkey: string): Promise<NDKEvent | null> {
  const cachedEvent = bookmarkEventCache.get(pubkey);
  if (cachedEvent) {
    return cachedEvent;
  }

  return new Promise((resolve) => {
    let latestEvent: NDKEvent | null = null;
    const sub = ndk.subscribe(
      { kinds: [KIND_BOOKMARK_LIST], authors: [pubkey], limit: 1 },
      { closeOnEose: true },
    );

    const timeout = setTimeout(() => {
      sub.stop();
      resolve(latestEvent);
    }, 3000);

    sub.on('event', (event: NDKEvent) => {
      if (!latestEvent || (event.created_at || 0) > (latestEvent.created_at || 0)) {
        latestEvent = event;
      }
    });

    sub.on('eose', () => {
      clearTimeout(timeout);
      sub.stop();
      resolve(latestEvent);
    });
  });
}

export function createFavoriteReposStore(pubkey?: string) {
  const pubkeyHex = normalizePubkey(pubkey);

  const { subscribe: storeSubscribe, set } = writable<FavoriteRepos | undefined>(
    pubkeyHex ? favoritesCache.get(pubkeyHex) : undefined,
  );

  if (pubkeyHex) {
    const unsubscribe = favoritesEmitter.subscribe(pubkeyHex, set);

    const cached = favoritesCache.get(pubkeyHex);
    if (cached) {
      set(cached);
    } else {
      fetchFavoriteRepos(pubkeyHex);
    }

    return {
      subscribe: storeSubscribe,
      destroy: unsubscribe,
    };
  }

  return {
    subscribe: storeSubscribe,
    destroy: () => {},
  };
}

export function getFavoriteReposSync(pubkey?: string): FavoriteRepos | undefined {
  const pubkeyHex = normalizePubkey(pubkey);
  return pubkeyHex ? favoritesCache.get(pubkeyHex) : undefined;
}

export async function toggleFavoriteRepo(ownerNpub: string, repoName: string): Promise<boolean> {
  const viewerPubkey = nostrStore.getState().pubkey;
  if (!viewerPubkey || !ndk.signer) {
    return false;
  }

  const repoAddress = buildRepoAddress(ownerNpub, repoName);
  const existingEvent = await fetchLatestBookmarkListEvent(viewerPubkey);

  const bookmarkEvent = existingEvent
    ? new NDKEvent(ndk, existingEvent.rawEvent())
    : new NDKEvent(ndk, {
      kind: KIND_BOOKMARK_LIST,
      content: '',
      tags: [],
    } as NostrEvent);

  bookmarkEvent.kind = KIND_BOOKMARK_LIST;
  bookmarkEvent.content = bookmarkEvent.content || '';

  const isFavorited = bookmarkEvent.tags.some(
    tag => tag[0] === 'a' && tag[1] === repoAddress,
  );

  bookmarkEvent.tags = bookmarkEvent.tags.filter(
    tag => !(tag[0] === 'a' && tag[1] === repoAddress),
  );

  if (!isFavorited) {
    bookmarkEvent.tags.unshift(['a', repoAddress]);
  }

  const now = Math.floor(Date.now() / 1000);
  bookmarkEvent.created_at = Math.max(now, lastFavoriteTimestamp + 1);
  lastFavoriteTimestamp = bookmarkEvent.created_at;
  bookmarkEvent.id = '';
  bookmarkEvent.sig = '';

  await bookmarkEvent.publish();

  const snapshot: FavoriteRepos = {
    pubkey: viewerPubkey,
    repos: extractFavoriteRepoRefs(bookmarkEvent.tags),
    updatedAt: bookmarkEvent.created_at,
  };

  bookmarkEventCache.set(viewerPubkey, bookmarkEvent);
  favoritesCache.set(viewerPubkey, snapshot);
  favoritesEmitter.notify(viewerPubkey, snapshot);

  return !isFavorited;
}

export function invalidateFavoriteRepos(pubkey: string): void {
  const pubkeyHex = normalizePubkey(pubkey);
  if (!pubkeyHex) {
    return;
  }

  favoritesCache.delete(pubkeyHex);
  bookmarkEventCache.delete(pubkeyHex);
  activeSubscriptions.get(pubkeyHex)?.stop();
  activeSubscriptions.delete(pubkeyHex);
  fetchFavoriteRepos(pubkeyHex);
}
