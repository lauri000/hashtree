import { nhashDecode, toHex } from '@hashtree/core';
import { serializeHostedSiteHash, type HostedSite } from './siteConfig';
import {
  encodeImmutableHostLabel,
  encodeMutableHostLabel,
  encodePathSegments,
  normalizeHost,
} from './siteIdentity';

const PROD_PORTAL_HOST = 'sites.iris.to';
const LOCAL_PORTAL_HOST = 'sites.iris.localhost';

function resolveHostContext(currentHost?: string): {
  protocol: string;
  portalHost: string;
  runtimeSuffix: string;
} {
  if (currentHost) {
    const trimmedHost = currentHost.trim();
    const normalized = normalizeHost(trimmedHost);
    if (normalized === LOCAL_PORTAL_HOST) {
      return {
        protocol: 'http:',
        portalHost: trimmedHost,
        runtimeSuffix: trimmedHost,
      };
    }
    if (normalized.endsWith(`.${LOCAL_PORTAL_HOST}`)) {
      const dotIndex = trimmedHost.indexOf('.');
      const localSuffix = dotIndex >= 0 ? trimmedHost.slice(dotIndex + 1) : LOCAL_PORTAL_HOST;
      return {
        protocol: 'http:',
        portalHost: localSuffix,
        runtimeSuffix: localSuffix,
      };
    }
  }

  if (typeof window !== 'undefined') {
    const current = window.location.host;
    const normalized = normalizeHost(current);
    if (normalized === LOCAL_PORTAL_HOST) {
      return {
        protocol: window.location.protocol || 'http:',
        portalHost: current,
        runtimeSuffix: current,
      };
    }
    if (normalized.endsWith(`.${LOCAL_PORTAL_HOST}`)) {
      const dotIndex = current.indexOf('.');
      const localSuffix = dotIndex >= 0 ? current.slice(dotIndex + 1) : LOCAL_PORTAL_HOST;
      return {
        protocol: window.location.protocol || 'http:',
        portalHost: localSuffix,
        runtimeSuffix: localSuffix,
      };
    }
  }

  return {
    protocol: 'https:',
    portalHost: PROD_PORTAL_HOST,
    runtimeSuffix: 'hashtree.cc',
  };
}

function serializeRuntimeHash(site: HostedSite): string {
  const entryPath = encodePathSegments(site.entryPath || 'index.html');
  if (site.kind === 'immutable') {
    const cid = nhashDecode(site.nhash);
    const params = new URLSearchParams();
    if (cid.key) {
      params.set('k', toHex(cid.key));
    }
    const query = params.toString();
    return `#/${entryPath}${query ? `?${query}` : ''}`;
  }
  return `#/${site.npub}/${encodeURIComponent(site.treeName)}/${entryPath}`;
}

function buildRuntimeHostPrefix(site: HostedSite): string {
  if (site.kind === 'immutable') {
    return encodeImmutableHostLabel(nhashDecode(site.nhash).hash);
  }

  return encodeMutableHostLabel(site.npub, site.treeName);
}

export function isPortalShellHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === PROD_PORTAL_HOST || normalized === LOCAL_PORTAL_HOST;
}

export async function buildIsolatedSiteHref(site: HostedSite, currentHost?: string): Promise<string> {
  const hostContext = resolveHostContext(currentHost);
  const runtimeHostPrefix = buildRuntimeHostPrefix(site);
  return `${hostContext.protocol}//${runtimeHostPrefix}.${hostContext.runtimeSuffix}/${serializeRuntimeHash(site)}`;
}

export function buildLauncherHref(site: HostedSite, currentHost?: string): string {
  const hostContext = resolveHostContext(currentHost);
  return `${hostContext.protocol}//${hostContext.portalHost}/${serializeHostedSiteHash(site)}`;
}
