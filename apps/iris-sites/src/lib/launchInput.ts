import { resolveHostedSite, type HostedSite } from './siteConfig';

const PORTAL_HOST = 'sites.iris.to';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseSiteUrl(raw: string): HostedSite | null {
  try {
    const url = new URL(raw);
    if (url.hash.startsWith('#/')) {
      return resolveHostedSite({
        host: PORTAL_HOST,
        hash: url.hash,
      });
    }
  } catch {
    // Fall through to bare route parsing.
  }
  return null;
}

function parseHtreeUrl(raw: string): HostedSite | null {
  if (!raw.startsWith('htree://')) return null;

  const target = raw.slice('htree://'.length).replace(/^\/+/, '');
  if (!target) return null;
  if (target.startsWith('nhash1')) {
    const [nhash, ...pathParts] = target.split('/').filter(Boolean);
    return {
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Isolated Site',
      nhash,
      entryPath: safeDecode(pathParts.join('/') || 'index.html'),
    };
  }
  if (target.startsWith('npub1')) {
    const [npub, ...treeParts] = target.split('/').filter(Boolean);
    if (!npub || !treeParts.length) return null;
    const treeName = safeDecode(treeParts.join('/'));
    return {
      kind: 'mutable',
      siteKey: 'pilot',
      title: treeName || 'Isolated Site',
      npub,
      treeName,
      entryPath: 'index.html',
    };
  }
  return null;
}

export function parseLaunchInput(raw: string): HostedSite | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return parseSiteUrl(trimmed);
  }

  if (trimmed.startsWith('htree://')) {
    return parseHtreeUrl(trimmed);
  }

  if (trimmed.startsWith('#/')) {
    return resolveHostedSite({
      host: PORTAL_HOST,
      hash: trimmed,
    });
  }

  if (trimmed.startsWith('nhash1')) {
    const [nhash, ...pathParts] = trimmed.split('/').filter(Boolean);
    return {
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Isolated Site',
      nhash,
      entryPath: safeDecode(pathParts.join('/') || 'index.html'),
    };
  }

  if (trimmed.startsWith('npub1')) {
    const [npub, ...treeParts] = trimmed.split('/').filter(Boolean);
    if (!npub || !treeParts.length) return null;
    const treeName = safeDecode(treeParts.join('/'));
    return {
      kind: 'mutable',
      siteKey: 'pilot',
      title: treeName || 'Isolated Site',
      npub,
      treeName,
      entryPath: 'index.html',
    };
  }

  return null;
}
