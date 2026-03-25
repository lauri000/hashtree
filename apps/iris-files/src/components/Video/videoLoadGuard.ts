import type { CID } from '@hashtree/core';

export interface PlaylistRedirectOptions {
  activeLoadKey: string | null;
  expectedLoadKey: string;
  npub: string;
  treeName: string;
  firstVideoId: string | null;
}

export interface PendingPlaylistRedirect {
  rootCid: CID;
  videoCid?: CID | null;
}

const PENDING_PLAYLIST_REDIRECT_TTL_MS = 30_000;
const pendingPlaylistRedirects = new Map<string, {
  value: PendingPlaylistRedirect;
  expiresAt: number;
}>();

function getPendingPlaylistRedirectKey(npub: string, treeName: string, videoId: string): string {
  return `${npub}/${treeName}/${videoId}`;
}

export function isActiveVideoLoad(
  activeLoadKey: string | null,
  expectedLoadKey: string,
): boolean {
  return activeLoadKey === expectedLoadKey;
}

export function buildPlaylistRedirectHash(
  options: PlaylistRedirectOptions,
): string | null {
  if (!options.firstVideoId) return null;
  if (!isActiveVideoLoad(options.activeLoadKey, options.expectedLoadKey)) {
    return null;
  }
  return `#/${options.npub}/${encodeURIComponent(options.treeName)}/${encodeURIComponent(options.firstVideoId)}`;
}

export function rememberPendingPlaylistRedirect(options: {
  npub: string;
  treeName: string;
  videoId: string;
  rootCid: CID;
  videoCid?: CID | null;
}): void {
  pendingPlaylistRedirects.set(
    getPendingPlaylistRedirectKey(options.npub, options.treeName, options.videoId),
    {
      value: {
        rootCid: options.rootCid,
        videoCid: options.videoCid,
      },
      expiresAt: Date.now() + PENDING_PLAYLIST_REDIRECT_TTL_MS,
    },
  );
}

export function consumePendingPlaylistRedirect(
  npub: string,
  treeName: string,
  videoId: string,
): PendingPlaylistRedirect | null {
  const key = getPendingPlaylistRedirectKey(npub, treeName, videoId);
  const entry = pendingPlaylistRedirects.get(key);
  if (!entry) return null;
  pendingPlaylistRedirects.delete(key);
  if (entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry.value;
}
