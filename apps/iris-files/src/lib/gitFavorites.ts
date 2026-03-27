import { nip19 } from 'nostr-tools';
import { KIND_REPO_ANNOUNCEMENT } from '../utils/constants';

export interface FavoriteRepoRef {
  address: string;
  ownerPubkey: string;
  ownerNpub: string;
  repoName: string;
  href: string;
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

export function extractFavoriteRepoRefs(tags: string[][]): FavoriteRepoRef[] {
  const refs: FavoriteRepoRef[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    if (tag[0] !== 'a' || !tag[1]) {
      continue;
    }

    const ref = parseFavoriteRepoAddress(tag[1]);
    if (!ref || seen.has(ref.address)) {
      continue;
    }

    seen.add(ref.address);
    refs.push(ref);
  }

  return refs;
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
