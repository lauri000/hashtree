import { nip19 } from 'nostr-tools';
import { KIND_REPO_ANNOUNCEMENT } from '../utils/constants';

export interface GitRepoAnnouncementEvent {
  id?: string | null;
  pubkey?: string | null;
  created_at?: number;
  content?: string | null;
  tags: string[][];
}

export interface GitRepoAnnouncement {
  id: string | null;
  address: string;
  ownerPubkey: string;
  ownerNpub: string;
  repoName: string;
  createdAt: number;
  description: string;
  cloneUrls: string[];
  webUrls: string[];
  earliestUniqueCommit: string | null;
  isPersonalFork: boolean;
}

export interface ForkOriginLink {
  href: string;
  label: string;
  npub: string;
  repoName: string;
}

export function buildGitRepoAnnouncementAddress(ownerPubkey: string, repoName: string): string {
  return `${KIND_REPO_ANNOUNCEMENT}:${ownerPubkey}:${repoName}`;
}

export function extractEarliestUniqueCommit(tags: string[][]): string | null {
  for (const tag of tags) {
    if (tag[0] === 'r' && tag[1] && tag[2] === 'euc') {
      return tag[1];
    }
  }

  return null;
}

export function isPersonalForkAnnouncement(tags: string[][]): boolean {
  return tags.some(tag => tag[0] === 't' && tag[1] === 'personal-fork');
}

export function isNewerGitRepoAnnouncement(
  candidate: Pick<GitRepoAnnouncement, 'createdAt' | 'id'>,
  current?: Pick<GitRepoAnnouncement, 'createdAt' | 'id'> | null,
): boolean {
  if (!current) {
    return true;
  }

  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt > current.createdAt;
  }

  return (candidate.id || '') >= (current.id || '');
}

export function parseGitRepoAnnouncement(event: GitRepoAnnouncementEvent): GitRepoAnnouncement | null {
  const ownerPubkey = event.pubkey?.trim();
  if (!ownerPubkey) {
    return null;
  }

  const repoName = event.tags.find(tag => tag[0] === 'd' && tag[1])?.[1]?.trim();
  if (!repoName) {
    return null;
  }

  return {
    id: event.id ?? null,
    address: buildGitRepoAnnouncementAddress(ownerPubkey, repoName),
    ownerPubkey,
    ownerNpub: nip19.npubEncode(ownerPubkey),
    repoName,
    createdAt: event.created_at || 0,
    description: event.tags.find(tag => tag[0] === 'description' && tag[1])?.[1] || (event.content || ''),
    cloneUrls: event.tags.filter(tag => tag[0] === 'clone' && tag[1]).map(tag => tag[1]),
    webUrls: event.tags.filter(tag => tag[0] === 'web' && tag[1]).map(tag => tag[1]),
    earliestUniqueCommit: extractEarliestUniqueCommit(event.tags),
    isPersonalFork: isPersonalForkAnnouncement(event.tags),
  };
}

export function parseForkOriginLink(value: string): ForkOriginLink | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'htree:' || !url.hostname.startsWith('npub1')) {
    return null;
  }

  const repoParts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (repoParts.length === 0) {
    return null;
  }

  const npub = url.hostname;
  const repoName = repoParts.join('/');

  return {
    href: `#/${[npub, ...repoParts].map(encodeURIComponent).join('/')}`,
    label: `${npub}/${repoName}`,
    npub,
    repoName,
  };
}
