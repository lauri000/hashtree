import type { BlossomServerConfig } from '@hashtree/worker';

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

export function normalizeRuntimeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function normalizeRelayUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function normalizeBlossomServer(server: BlossomServerConfig): BlossomServerConfig | null {
  const url = normalizeRuntimeUrl(server.url);
  if (!url) return null;
  return {
    url,
    read: server.read ?? true,
    write: server.write ?? false,
  };
}

export function getIrisRuntimeServerUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const override = window.__HTREE_SERVER_URL__;
  const fallback = getQueryParam('iris_htree_server');
  const candidate = typeof override === 'string' && override.trim() ? override : fallback;
  if (typeof candidate !== 'string') return null;
  const normalized = normalizeRuntimeUrl(candidate);
  return normalized || null;
}

export function getIrisRuntimeDaemonRelayUrl(): string | null {
  const serverUrl = getIrisRuntimeServerUrl();
  if (!serverUrl) return null;
  try {
    const url = new URL(serverUrl);
    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    } else {
      return null;
    }
    url.pathname = '/ws';
    url.search = '';
    url.hash = '';
    return normalizeRelayUrl(url.toString());
  } catch {
    return null;
  }
}

export function getEffectiveRelayUrls(relays: string[]): string[] {
  const merged = new Set<string>();
  const daemonRelayUrl = getIrisRuntimeDaemonRelayUrl();
  if (daemonRelayUrl) {
    merged.add(daemonRelayUrl);
  }
  for (const relay of relays) {
    const normalized = normalizeRelayUrl(relay);
    if (!normalized) continue;
    merged.add(normalized);
  }
  return Array.from(merged.values());
}

export function getEffectiveBlossomServers(servers: BlossomServerConfig[]): BlossomServerConfig[] {
  const merged = new Map<string, BlossomServerConfig>();
  const runtimeServerUrl = getIrisRuntimeServerUrl();
  if (runtimeServerUrl) {
    merged.set(runtimeServerUrl, {
      url: runtimeServerUrl,
      read: true,
      write: true,
    });
  }

  for (const server of servers) {
    const normalized = normalizeBlossomServer(server);
    if (!normalized) continue;
    const existing = merged.get(normalized.url);
    if (existing) {
      merged.set(normalized.url, {
        url: normalized.url,
        read: existing.read || normalized.read,
        write: existing.write || normalized.write,
      });
      continue;
    }
    merged.set(normalized.url, normalized);
  }

  return Array.from(merged.values());
}
