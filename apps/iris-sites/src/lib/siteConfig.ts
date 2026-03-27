import { nhashDecode, nhashEncode, toHex } from '@hashtree/core';
import {
  decodeImmutableHostLabel,
  encodeMutableHostLabel,
  encodePathSegments,
  normalizeHost,
} from './siteIdentity';

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

const PROD_PORTAL_HOST = 'sites.iris.to';
const LOCAL_PORTAL_HOST = 'sites.iris.localhost';

function decodeHashRoute(hash: string | undefined): { parts: string[]; params: URLSearchParams } {
  const trimmed = (hash || '').trim();
  if (!trimmed.startsWith('#/')) {
    return { parts: [], params: new URLSearchParams() };
  }

  const route = trimmed.slice(2);
  const [pathPart, queryPart = ''] = route.split('?', 2);
  const parts = pathPart
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

  return {
    parts,
    params: new URLSearchParams(queryPart),
  };
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

function parseGenericHashSite(hash: string | undefined): HostedSite | null {
  const { parts } = decodeHashRoute(hash);

  if (parts[0] === 'nhash' && parts[1] && isMaybeNhash(parts[1])) {
    return createGenericImmutableSite(parts[1], parts.slice(2).join('/') || 'index.html');
  }

  if (parts[0] && isMaybeNhash(parts[0])) {
    return createGenericImmutableSite(parts[0], parts.slice(1).join('/') || 'index.html');
  }

  if (parts[0] === 'npub' && parts[1] && parts[2] && isMaybeNpub(parts[1])) {
    return createGenericMutableSite(parts[1], parts[2], parts.slice(3).join('/') || 'index.html');
  }

  if (parts[0] && parts[1] && isMaybeNpub(parts[0])) {
    return createGenericMutableSite(parts[0], parts[1], parts.slice(2).join('/') || 'index.html');
  }

  return null;
}

interface RuntimeSiteHint {
  label: string;
  hash: Uint8Array;
}

function parseRuntimeSiteHint(host: string): RuntimeSiteHint | null {
  const normalized = normalizeHost(host);
  if (!normalized || normalized === PROD_PORTAL_HOST || normalized === LOCAL_PORTAL_HOST) {
    return null;
  }

  let prefix = '';
  if (normalized.endsWith('.hashtree.cc')) {
    prefix = normalized.slice(0, -'.hashtree.cc'.length);
  } else if (normalized.endsWith(`.${LOCAL_PORTAL_HOST}`)) {
    prefix = normalized.slice(0, -(`.${LOCAL_PORTAL_HOST}`.length));
  } else {
    return null;
  }

  const labels = prefix.split('.').filter(Boolean);
  if (!labels.length) return null;

  if (labels.length === 1) {
    const hash = decodeImmutableHostLabel(labels[0]);
    if (hash) {
      return {
        label: labels[0],
        hash,
      };
    }
  }

  return null;
}

function resolveImmutableRuntimeSite(hint: RuntimeSiteHint, hash: string | undefined): HostedSite | null {
  const bareNhash = nhashEncode(hint.hash);
  const generic = parseGenericHashSite(hash);
  if (generic?.kind === 'immutable') {
    try {
      // Runtime hosts are the security boundary. A fragment must not be able to
      // smuggle in a different immutable root under the same origin.
      if (nhashEncode(nhashDecode(generic.nhash).hash) !== bareNhash) {
        return null;
      }
    } catch {
      return null;
    }
    return generic;
  }

  const { parts, params } = decodeHashRoute(hash);
  const entryPath = parts.join('/') || 'index.html';
  const decryptKey = params.get('k')?.trim();

  if (!decryptKey) {
    return createGenericImmutableSite(bareNhash, entryPath);
  }

  if (!/^[a-f0-9]{64}$/i.test(decryptKey)) {
    return null;
  }

  try {
    return createGenericImmutableSite(
      nhashEncode({ hash: toHex(hint.hash), decryptKey: decryptKey.toLowerCase() }),
      entryPath,
    );
  } catch {
    return null;
  }
}

function resolveMutableRuntimeSite(hint: RuntimeSiteHint, hash: string | undefined): HostedSite | null {
  const generic = parseGenericHashSite(hash);
  if (generic?.kind === 'mutable') {
    // Refuse cross-site spoofing like real-site.hashtree.cc/#/attacker/tree:
    // the fragment must reproduce the exact opaque hostname label derived
    // from the full mutable route.
    if (encodeMutableHostLabel(generic.npub, generic.treeName) !== hint.label) {
      return null;
    }
    return generic;
  }

  return null;
}

export function serializeHostedSiteHash(site: HostedSite): string {
  const entryPath = encodePathSegments(site.entryPath || 'index.html');
  if (site.kind === 'immutable') {
    return `#/${site.nhash}/${entryPath}`;
  }
  return `#/${site.npub}/${encodeURIComponent(site.treeName)}/${entryPath}`;
}

export function resolveHostedSite(location: SiteLocationLike): HostedSite | null {
  const normalizedHost = normalizeHost(location.host);
  const runtimeHint = parseRuntimeSiteHint(location.host);
  if (runtimeHint) {
    const generic = parseGenericHashSite(location.hash);
    if (generic?.kind === 'mutable') {
      return resolveMutableRuntimeSite(runtimeHint, location.hash);
    }
    return resolveImmutableRuntimeSite(runtimeHint, location.hash);
  }

  if (normalizedHost === PROD_PORTAL_HOST || normalizedHost === LOCAL_PORTAL_HOST) {
    return parseGenericHashSite(location.hash);
  }

  return null;
}
