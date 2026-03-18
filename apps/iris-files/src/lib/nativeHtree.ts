/**
 * Native htree host policy helpers.
 *
 * Iris injects a local daemon URL into native webviews. That direct HTTP
 * endpoint is useful for local/native pages, but secure HTTPS apps such as
 * video.iris.to must keep using same-origin /htree routes so the browser can
 * load media without mixed-content issues and the service worker can intercept
 * those requests.
 */

declare global {
  interface Window {
    __HTREE_SERVER_URL__?: string;
  }
}

export function getInjectedHtreeServerUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const override = window.__HTREE_SERVER_URL__;
  if (typeof override !== 'string') return null;
  const trimmed = override.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : null;
}

function getPageProtocol(): string | null {
  if (typeof window === 'undefined') return null;
  const protocol = window.location?.protocol;
  return typeof protocol === 'string' ? protocol.toLowerCase() : null;
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
  return getPageProtocol() === 'https:' && getServerProtocol(serverUrl) === 'http:';
}

export function canUseInjectedHtreeServerUrl(): boolean {
  const serverUrl = getInjectedHtreeServerUrl();
  return !!serverUrl && !shouldPreferSameOriginHtreeRoutes();
}
