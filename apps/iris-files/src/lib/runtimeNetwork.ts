import type { BlossomServerConfig } from '../stores/settings';
import { getInjectedHtreeServerUrl } from './nativeHtree';

export function normalizeRuntimeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function normalizeBlossomServer(server: BlossomServerConfig): BlossomServerConfig | null {
  const url = normalizeRuntimeServerUrl(server.url);
  if (!url) return null;
  return {
    url,
    read: server.read ?? true,
    write: server.write ?? false,
  };
}

export function getEmbeddedDaemonBlossomServer(): BlossomServerConfig | null {
  const serverUrl = getInjectedHtreeServerUrl();
  if (!serverUrl) return null;
  return {
    url: normalizeRuntimeServerUrl(serverUrl),
    read: true,
    write: true,
  };
}

export function getEffectiveBlossomServers(servers: BlossomServerConfig[]): BlossomServerConfig[] {
  const merged = new Map<string, BlossomServerConfig>();
  const candidates = getEmbeddedDaemonBlossomServer()
    ? [getEmbeddedDaemonBlossomServer()!, ...servers]
    : servers;

  for (const candidate of candidates) {
    const normalized = normalizeBlossomServer(candidate);
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
