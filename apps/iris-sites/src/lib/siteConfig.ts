interface HostedSiteBase {
  siteKey: string;
  title: string;
  entryPath?: string;
}

export interface ImmutableHostedSite extends HostedSiteBase {
  kind: 'immutable';
  nhash: string;
}

export interface MutableHostedSite extends HostedSiteBase {
  kind: 'mutable';
  npub: string;
  treeName: string;
}

export type HostedSite = ImmutableHostedSite | MutableHostedSite;

export interface SiteLocationLike {
  host: string;
  hash?: string;
}

function decodeHashPath(hash: string | undefined): string[] {
  const trimmed = (hash || '').trim();
  if (!trimmed.startsWith('#/')) return [];
  return trimmed
    .slice(2)
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

function isMaybeNhash(value: string): boolean {
  return /^nhash1[a-z0-9]+$/.test(value);
}

function isMaybeNpub(value: string): boolean {
  return /^npub1[a-z0-9]+$/.test(value);
}

function createGenericImmutableSite(nhash: string, entryPath: string): ImmutableHostedSite {
  return {
    kind: 'immutable',
    siteKey: 'pilot',
    title: 'Isolated Site',
    nhash,
    entryPath,
  };
}

function createGenericMutableSite(npub: string, treeName: string, entryPath: string): MutableHostedSite {
  return {
    kind: 'mutable',
    siteKey: 'pilot',
    title: treeName || 'Isolated Site',
    npub,
    treeName,
    entryPath,
  };
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function serializeHostedSiteHash(site: HostedSite): string {
  const entryPath = encodePathSegments(site.entryPath || 'index.html');
  if (site.kind === 'immutable') {
    return `#/${site.nhash}/${entryPath}`;
  }
  return `#/${site.npub}/${encodeURIComponent(site.treeName)}/${entryPath}`;
}

export function resolveHostedSite(location: SiteLocationLike): HostedSite | null {
  const hashParts = decodeHashPath(location.hash);

  if (hashParts[0] === 'nhash' && hashParts[1] && isMaybeNhash(hashParts[1])) {
    return createGenericImmutableSite(hashParts[1], hashParts.slice(2).join('/') || 'index.html');
  }

  if (hashParts[0] && isMaybeNhash(hashParts[0])) {
    return createGenericImmutableSite(hashParts[0], hashParts.slice(1).join('/') || 'index.html');
  }

  if (hashParts[0] === 'npub' && hashParts[1] && hashParts[2] && isMaybeNpub(hashParts[1])) {
    return createGenericMutableSite(hashParts[1], hashParts[2], hashParts.slice(3).join('/') || 'index.html');
  }

  if (hashParts[0] && hashParts[1] && isMaybeNpub(hashParts[0])) {
    return createGenericMutableSite(hashParts[0], hashParts[1], hashParts.slice(2).join('/') || 'index.html');
  }

  return null;
}
