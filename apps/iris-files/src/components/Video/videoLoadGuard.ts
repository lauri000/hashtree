export interface PlaylistRedirectOptions {
  activeLoadKey: string | null;
  expectedLoadKey: string;
  npub: string;
  treeName: string;
  firstVideoId: string | null;
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
