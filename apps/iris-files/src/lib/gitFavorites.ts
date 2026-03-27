import { nip19 } from 'nostr-tools';
import { KIND_REPO_ANNOUNCEMENT } from '../utils/constants';

export const GIT_REPO_REACTION_KIND = 'git-repo';

export interface FavoriteRepoRef {
  address: string;
  ownerPubkey: string;
  ownerNpub: string;
  repoName: string;
  href: string;
}

export interface FavoriteRepoReactionEvent {
  pubkey?: string | null;
  created_at?: number;
  content?: string | null;
  tags: string[][];
}

export function buildFavoriteRepoHref(ownerNpub: string, repoName: string): string {
  const encodedRepoPath = repoName
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');

  return `#/${encodeURIComponent(ownerNpub)}/${encodedRepoPath}`;
}

export function parseFavoriteRepoAddress(address: string): FavoriteRepoRef | null {
  const parts = address.split(':');
  if (parts.length !== 3 || parts[0] !== String(KIND_REPO_ANNOUNCEMENT)) {
    return null;
  }

  const ownerPubkey = parts[1];
  const repoName = parts[2];
  const ownerNpub = nip19.npubEncode(ownerPubkey);

  return {
    address,
    ownerPubkey,
    ownerNpub,
    repoName,
    href: buildFavoriteRepoHref(ownerNpub, repoName),
  };
}

export function isPositiveFavoriteReaction(content?: string | null): boolean {
  const normalized = (content || '').trim();
  return normalized === '' || normalized === '+';
}

export function isNewerFavoriteReaction(
  candidate: Pick<FavoriteRepoReactionEvent, 'created_at'>,
  current?: Pick<FavoriteRepoReactionEvent, 'created_at'> | null,
): boolean {
  if (!current) {
    return true;
  }

  return (candidate.created_at || 0) >= (current.created_at || 0);
}

export function extractFavoriteRepoAddressFromReaction(tags: string[][]): string | null {
  const hasRepoKind = tags.some(tag => tag[0] === 'k' && tag[1] === GIT_REPO_REACTION_KIND);
  if (!hasRepoKind) {
    return null;
  }

  for (const tag of tags) {
    if (tag[0] !== 'i' || !tag[1]) {
      continue;
    }

    const ref = parseFavoriteRepoAddress(tag[1]);
    if (!ref) {
      continue;
    }

    return ref.address;
  }

  return null;
}

export function extractFavoriteRepoRefsFromReactions(
  events: FavoriteRepoReactionEvent[],
): FavoriteRepoRef[] {
  const latestByAddress = new Map<string, FavoriteRepoReactionEvent>();

  for (const event of events) {
    const address = extractFavoriteRepoAddressFromReaction(event.tags);
    if (!address) {
      continue;
    }

    const current = latestByAddress.get(address);
    if (isNewerFavoriteReaction(event, current)) {
      latestByAddress.set(address, event);
    }
  }

  return [...latestByAddress.entries()]
    .filter(([, event]) => isPositiveFavoriteReaction(event.content))
    .sort((a, b) => {
      const timestampDelta = (b[1].created_at || 0) - (a[1].created_at || 0);
      if (timestampDelta !== 0) {
        return timestampDelta;
      }

      return a[0].localeCompare(b[0]);
    })
    .map(([address]) => parseFavoriteRepoAddress(address))
    .filter((ref): ref is FavoriteRepoRef => !!ref);
}

export function countFavoriteRepoLikes(events: FavoriteRepoReactionEvent[]): number {
  const latestByPubkey = new Map<string, FavoriteRepoReactionEvent>();

  for (const event of events) {
    const pubkey = event.pubkey?.trim();
    if (!pubkey || !extractFavoriteRepoAddressFromReaction(event.tags)) {
      continue;
    }

    const current = latestByPubkey.get(pubkey);
    if (isNewerFavoriteReaction(event, current)) {
      latestByPubkey.set(pubkey, event);
    }
  }

  return [...latestByPubkey.values()].filter(event => isPositiveFavoriteReaction(event.content)).length;
}

export function filterOwnedFavoriteRepos(
  ownerNpub: string,
  ownedRepoNames: string[],
  favorites: FavoriteRepoRef[],
): FavoriteRepoRef[] {
  const ownedRepoKeys = new Set(
    ownedRepoNames.map(name => `${ownerNpub}/${name}`),
  );

  return favorites.filter(
    favorite => !ownedRepoKeys.has(`${favorite.ownerNpub}/${favorite.repoName}`),
  );
}
