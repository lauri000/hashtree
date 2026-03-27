import type { HostedSite } from './siteConfig';
import { serializeHostedSiteHash } from './siteConfig';

const PROD_PORTAL_HOST = 'sites.iris.to';
const LOCAL_PORTAL_HOST = 'sites.iris.localhost';

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, '');
}

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
  }

  return {
    protocol: 'https:',
    portalHost: PROD_PORTAL_HOST,
    runtimeSuffix: 'hashtree.cc',
  };
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function isPortalShellHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === PROD_PORTAL_HOST || normalized === LOCAL_PORTAL_HOST;
}

function siteDigestKey(site: HostedSite): string {
  if (site.kind === 'immutable') {
    return `immutable:${site.nhash}`;
  }
  return `mutable:${site.npub}/${site.treeName}`;
}

export async function buildIsolatedSiteHref(site: HostedSite, currentHost?: string): Promise<string> {
  const hostContext = resolveHostContext(currentHost);

  const digest = await sha256Hex(`htree-site:${siteDigestKey(site)}`);
  const subdomain = digest.slice(0, 24);
  return `${hostContext.protocol}//${subdomain}.${hostContext.runtimeSuffix}/${serializeHostedSiteHash(site)}`;
}
