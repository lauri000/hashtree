import type { HostedSite } from './siteConfig';

export const MENU_HIDDEN_PARAM = 'menu';
export const AUTO_RELOAD_PARAM = 'reload';
const AUTO_RELOAD_STORAGE_PREFIX = 'iris-sites:auto-reload:';

function parseHashRoute(hash: string): { path: string; params: URLSearchParams } {
  if (!hash.startsWith('#/')) {
    return { path: '', params: new URLSearchParams() };
  }

  const route = hash.slice(2);
  const [path, query = ''] = route.split('?', 2);
  return {
    path,
    params: new URLSearchParams(query),
  };
}

export function isMenuHidden(hash: string): boolean {
  const value = parseHashRoute(hash).params.get(MENU_HIDDEN_PARAM)?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off' || value === 'hidden';
}

export function readHashBooleanParam(hash: string, key: string): boolean | null {
  const value = parseHashRoute(hash).params.get(key)?.trim().toLowerCase();
  if (!value) return null;
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  return null;
}

export function setHashRouteParam(hash: string, key: string, value: string | null): string {
  if (!hash.startsWith('#/')) {
    return hash || '#/';
  }

  const { path, params } = parseHashRoute(hash);
  if (value == null) {
    params.delete(key);
  } else {
    params.set(key, value);
  }

  const query = params.toString();
  return `#/${path}${query ? `?${query}` : ''}`;
}

export function setMenuHidden(hash: string, hidden: boolean): string {
  return setHashRouteParam(hash, MENU_HIDDEN_PARAM, hidden ? '0' : null);
}

export function setAutoReload(hash: string, enabled: boolean | null): string {
  if (enabled == null) {
    return setHashRouteParam(hash, AUTO_RELOAD_PARAM, null);
  }
  return setHashRouteParam(hash, AUTO_RELOAD_PARAM, enabled ? '1' : '0');
}

export function getAutoReloadStorageKey(site: HostedSite): string {
  if (site.kind === 'mutable') {
    return `${AUTO_RELOAD_STORAGE_PREFIX}${site.npub}/${site.treeName}`;
  }
  return `${AUTO_RELOAD_STORAGE_PREFIX}${site.nhash}`;
}
