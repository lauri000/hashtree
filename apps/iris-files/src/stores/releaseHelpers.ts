import { getNpubFileUrl } from '../lib/mediaUrl';

const RELEASES_SUFFIX = 'releases';

function normalizeRepoPath(repoPath: string): string {
  return repoPath.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function buildReleaseTreeName(repoPath: string): string {
  const clean = normalizeRepoPath(repoPath);
  return clean ? `${RELEASES_SUFFIX}/${clean}` : RELEASES_SUFFIX;
}

export function getReleaseAssetUrl(
  npub: string,
  repoPath: string,
  releaseId: string,
  assetPath: string,
  linkKey?: string,
): string {
  const url = getNpubFileUrl(npub, buildReleaseTreeName(repoPath), `${releaseId}/${assetPath}`);
  if (!linkKey) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}k=${encodeURIComponent(linkKey)}`;
}

export function sanitizeReleaseId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const cleaned = trimmed
    .replace(/[\\/]/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, 80);
}

export function isListedReleaseEntryName(name: string): boolean {
  return name !== 'latest';
}
