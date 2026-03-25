/**
 * Native htree host policy helpers.
 *
 * Iris injects a local daemon URL into native webviews. Secure HTTPS apps such
 * as video.iris.to must keep using same-origin /htree routes so the browser can
 * load media without mixed-content issues and the service worker can intercept
 * those requests. Native htree:// pages can safely use the loopback daemon
 * directly for media and file fetches, which avoids buffering everything
 * through the custom protocol handler.
 */

declare global {
  interface Window {
    __HTREE_SERVER_URL__?: string;
  }
}

function getQueryParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = new URLSearchParams(window.location.search).get(name);
    return typeof value === 'string' ? value.trim() || null : null;
  } catch {
    return null;
  }
}

export function getInjectedHtreeServerUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const override = window.__HTREE_SERVER_URL__;
  const fallback = getQueryParam('iris_htree_server');
  const candidate = typeof override === 'string' && override.trim() ? override : fallback;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : null;
}

function getPageProtocol(): string | null {
  if (typeof window === 'undefined') return null;
  const protocol = window.location?.protocol;
  return typeof protocol === 'string' ? protocol.toLowerCase() : null;
}

function getPageHostname(): string | null {
  if (typeof window === 'undefined') return null;
  const hostname = window.location?.hostname;
  return typeof hostname === 'string' ? hostname.toLowerCase() : null;
}

function hasCanonicalHtreeIdentity(): boolean {
  const canonical = getQueryParam('iris_htree_canonical');
  return typeof canonical === 'string' && canonical.toLowerCase().startsWith('htree://');
}

function isLoopbackChildRuntime(): boolean {
  if (getPageProtocol() !== 'http:') return false;
  const hostname = getPageHostname();
  if (!hostname) return false;
  return hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname.endsWith('.htree.localhost');
}

export function shouldEagerLoadMediaInNativeChildRuntime(): boolean {
  return isLoopbackChildRuntime() && hasCanonicalHtreeIdentity();
}

function getServerProtocol(serverUrl: string): string | null {
  try {
    return new URL(serverUrl).protocol.toLowerCase();
  } catch {
    return null;
  }
}

export function shouldPreferSameOriginHtreeRoutes(): boolean {
  const serverUrl = getInjectedHtreeServerUrl();
  if (!serverUrl) return false;
  const serverProtocol = getServerProtocol(serverUrl);
  if (serverProtocol !== 'http:') return false;
  if (getPageProtocol() === 'https:') return true;
  if (getPageProtocol() === 'htree:') {
    const hostname = getPageHostname();
    if (hostname?.startsWith('npub1') || hostname === 'self') {
      return true;
    }
    return false;
  }
  if (hasCanonicalHtreeIdentity() && !isLoopbackChildRuntime()) return true;
  return false;
}

export function canUseInjectedHtreeServerUrl(): boolean {
  const serverUrl = getInjectedHtreeServerUrl();
  return !!serverUrl && !shouldPreferSameOriginHtreeRoutes();
}

export function canUseSameOriginHtreeProtocolStreaming(): boolean {
  return getPageProtocol() === 'htree:';
}
