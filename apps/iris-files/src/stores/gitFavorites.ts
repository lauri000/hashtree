import { writable } from 'svelte/store';
import { nip19 } from 'nostr-tools';
import { NDKEvent, ndk, nostrStore, npubToPubkey } from '../nostr';
import { buildRepoAddress } from '../nip34';
import { LRUCache } from '../utils/lruCache';
import { KeyedEventEmitter } from '../utils/keyedEventEmitter';
import { KIND_EXTERNAL_CONTENT_REACTION } from '../utils/constants';
import {
  countFavoriteRepoLikes,
  extractFavoriteRepoAddressFromReaction,
  extractFavoriteRepoRefsFromReactions,
  GIT_REPO_REACTION_KIND,
  isNewerFavoriteReaction,
  isPositiveFavoriteReaction,
  type FavoriteRepoReactionEvent,
  type FavoriteRepoRef,
} from '../lib/gitFavorites';

export interface FavoriteRepos {
  pubkey: string;
  repos: FavoriteRepoRef[];
  updatedAt: number;
}

export interface FavoriteRepoStats {
  address: string;
  count: number;
  updatedAt: number;
}

const favoritesCache = new LRUCache<string, FavoriteRepos>(100);
const favoritesEmitter = new KeyedEventEmitter<string, FavoriteRepos>();
const favoriteReactionCache = new Map<string, Map<string, FavoriteRepoReactionEvent>>();
const activeFavoriteSubscriptions = new Map<string, { stop: () => void }>();

const favoriteStatsCache = new LRUCache<string, FavoriteRepoStats>(200);
const favoriteStatsEmitter = new KeyedEventEmitter<string, FavoriteRepoStats>();
const favoriteRepoReactionCache = new Map<string, Map<string, FavoriteRepoReactionEvent>>();
const activeFavoriteStatsSubscriptions = new Map<string, { stop: () => void }>();

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

function getFavoriteReactionMap(pubkey: string): Map<string, FavoriteRepoReactionEvent> {
  let reactions = favoriteReactionCache.get(pubkey);
  if (!reactions) {
    reactions = new Map();
    favoriteReactionCache.set(pubkey, reactions);
  }

  return reactions;
}

function getFavoriteRepoReactionMap(repoAddress: string): Map<string, FavoriteRepoReactionEvent> {
  let reactions = favoriteRepoReactionCache.get(repoAddress);
  if (!reactions) {
    reactions = new Map();
    favoriteRepoReactionCache.set(repoAddress, reactions);
  }

  return reactions;
}

function rebuildFavoriteRepos(pubkey: string): void {
  const reactions = [...getFavoriteReactionMap(pubkey).values()];
  const snapshot: FavoriteRepos = {
    pubkey,
    repos: extractFavoriteRepoRefsFromReactions(reactions),
    updatedAt: reactions.reduce((latest, event) => Math.max(latest, event.created_at || 0), 0),
  };

  favoritesCache.set(pubkey, snapshot);
  favoritesEmitter.notify(pubkey, snapshot);
}

function rebuildFavoriteRepoStats(repoAddress: string): void {
  const reactions = [...getFavoriteRepoReactionMap(repoAddress).values()];
  const snapshot: FavoriteRepoStats = {
    address: repoAddress,
    count: countFavoriteRepoLikes(reactions),
    updatedAt: reactions.reduce((latest, event) => Math.max(latest, event.created_at || 0), 0),
  };

  favoriteStatsCache.set(repoAddress, snapshot);
  favoriteStatsEmitter.notify(repoAddress, snapshot);
}

function applyFavoriteAuthorReaction(authorPubkey: string, event: FavoriteRepoReactionEvent): void {
  const repoAddress = extractFavoriteRepoAddressFromReaction(event.tags);
  if (!repoAddress) {
    return;
  }

  const reactions = getFavoriteReactionMap(authorPubkey);
  const current = reactions.get(repoAddress);
  if (!isNewerFavoriteReaction(event, current)) {
    return;
  }

  reactions.set(repoAddress, event);
  rebuildFavoriteRepos(authorPubkey);
}

function applyFavoriteRepoReaction(event: FavoriteRepoReactionEvent): void {
  const repoAddress = extractFavoriteRepoAddressFromReaction(event.tags);
  const reactorPubkey = event.pubkey?.trim();
  if (!repoAddress || !reactorPubkey) {
    return;
  }

  const reactions = getFavoriteRepoReactionMap(repoAddress);
  const current = reactions.get(reactorPubkey);
  if (!isNewerFavoriteReaction(event, current)) {
    return;
  }

  reactions.set(reactorPubkey, event);
  rebuildFavoriteRepoStats(repoAddress);
}

function fetchFavoriteRepos(pubkey: string): void {
  if (!pubkey || pubkey.length !== 64 || activeFavoriteSubscriptions.has(pubkey)) {
    return;
  }

  const sub = ndk.subscribe(
    {
      kinds: [KIND_EXTERNAL_CONTENT_REACTION],
      authors: [pubkey],
      '#k': [GIT_REPO_REACTION_KIND],
    },
    { closeOnEose: false },
  );

  sub.on('event', (event: NDKEvent) => {
    applyFavoriteAuthorReaction(pubkey, event);
  });

  activeFavoriteSubscriptions.set(pubkey, { stop: () => sub.stop() });
}

function fetchFavoriteRepoStats(repoAddress: string): void {
  if (!repoAddress || activeFavoriteStatsSubscriptions.has(repoAddress)) {
    return;
  }

  const sub = ndk.subscribe(
    {
      kinds: [KIND_EXTERNAL_CONTENT_REACTION],
      '#k': [GIT_REPO_REACTION_KIND],
      '#i': [repoAddress],
    },
    { closeOnEose: false },
  );

  sub.on('event', (event: NDKEvent) => {
    applyFavoriteRepoReaction(event);
  });

  activeFavoriteStatsSubscriptions.set(repoAddress, { stop: () => sub.stop() });
}

async function fetchLatestFavoriteReactionEvent(
  pubkey: string,
  repoAddress: string,
): Promise<FavoriteRepoReactionEvent | null> {
  const cachedEvent = getFavoriteReactionMap(pubkey).get(repoAddress);
  if (cachedEvent) {
    return cachedEvent;
  }

  return new Promise((resolve) => {
    let latestEvent: FavoriteRepoReactionEvent | null = null;
    const sub = ndk.subscribe(
      {
        kinds: [KIND_EXTERNAL_CONTENT_REACTION],
        authors: [pubkey],
        '#k': [GIT_REPO_REACTION_KIND],
        '#i': [repoAddress],
        limit: 20,
      },
      { closeOnEose: true },
    );

    const timeout = setTimeout(() => {
      sub.stop();
      resolve(latestEvent);
    }, 3000);

    sub.on('event', (event: NDKEvent) => {
      if (isNewerFavoriteReaction(event, latestEvent)) {
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

function buildFavoriteRepoStatsKey(ownerNpub?: string, repoName?: string): string {
  if (!ownerNpub || !repoName) {
    return '';
  }

  try {
    return buildRepoAddress(ownerNpub, repoName);
  } catch {
    return '';
  }
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

export function createFavoriteRepoStatsStore(ownerNpub?: string, repoName?: string) {
  const repoAddress = buildFavoriteRepoStatsKey(ownerNpub, repoName);

  const { subscribe: storeSubscribe, set } = writable<FavoriteRepoStats | undefined>(
    repoAddress ? favoriteStatsCache.get(repoAddress) : undefined,
  );

  if (repoAddress) {
    const unsubscribe = favoriteStatsEmitter.subscribe(repoAddress, set);

    const cached = favoriteStatsCache.get(repoAddress);
    if (cached) {
      set(cached);
    } else {
      fetchFavoriteRepoStats(repoAddress);
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

export function getFavoriteRepoStatsSync(ownerNpub?: string, repoName?: string): FavoriteRepoStats | undefined {
  const repoAddress = buildFavoriteRepoStatsKey(ownerNpub, repoName);
  return repoAddress ? favoriteStatsCache.get(repoAddress) : undefined;
}

export async function toggleFavoriteRepo(ownerNpub: string, repoName: string): Promise<boolean> {
  const viewerPubkey = nostrStore.getState().pubkey;
  if (!viewerPubkey || !ndk.signer) {
    return false;
  }

  const ownerPubkey = npubToPubkey(ownerNpub);
  if (!ownerPubkey) {
    return false;
  }

  const repoAddress = buildRepoAddress(ownerNpub, repoName);
  const existingEvent = await fetchLatestFavoriteReactionEvent(viewerPubkey, repoAddress);
  const isFavorited = existingEvent ? isPositiveFavoriteReaction(existingEvent.content) : false;

  const favoriteEvent = new NDKEvent(ndk);
  favoriteEvent.kind = KIND_EXTERNAL_CONTENT_REACTION;
  favoriteEvent.content = isFavorited ? '-' : '+';
  favoriteEvent.tags = [
    ['k', GIT_REPO_REACTION_KIND],
    ['i', repoAddress],
    ['p', ownerPubkey],
  ];

  const now = Math.floor(Date.now() / 1000);
  favoriteEvent.created_at = Math.max(now, lastFavoriteTimestamp + 1);
  lastFavoriteTimestamp = favoriteEvent.created_at;

  await favoriteEvent.publish();

  const optimisticEvent: FavoriteRepoReactionEvent = {
    pubkey: viewerPubkey,
    created_at: favoriteEvent.created_at,
    content: favoriteEvent.content,
    tags: favoriteEvent.tags,
  };

  applyFavoriteAuthorReaction(viewerPubkey, optimisticEvent);
  applyFavoriteRepoReaction(optimisticEvent);

  return !isFavorited;
}

export function invalidateFavoriteRepos(pubkey: string): void {
  const pubkeyHex = normalizePubkey(pubkey);
  if (!pubkeyHex) {
    return;
  }

  favoritesCache.delete(pubkeyHex);
  favoriteReactionCache.delete(pubkeyHex);
  activeFavoriteSubscriptions.get(pubkeyHex)?.stop();
  activeFavoriteSubscriptions.delete(pubkeyHex);
  fetchFavoriteRepos(pubkeyHex);
}
