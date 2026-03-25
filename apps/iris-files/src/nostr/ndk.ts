/**
 * NDK Setup for Main Thread
 *
 * Web mode talks to configured relays directly.
 * Native mode talks to the embedded daemon's local `/ws` relay so real relay
 * sockets and fanout stay off the UI thread.
 *
 * NIP-07 signing must happen in main thread (browser extension access).
 */
import NDK, { NDKEvent, NDKPrivateKeySigner, NDKNip07Signer, type NostrEvent } from 'ndk';
import { getInjectedHtreeServerUrl } from '../lib/nativeHtree';

// Minimal NDK instance for signing only - no relays, no cache
export const ndk = new NDK({
  explicitRelayUrls: [],
});

function normalizeRelayUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function uniqueRelayUrls(relays: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const relay of relays) {
    const url = normalizeRelayUrl(relay);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
  }
  return normalized;
}

export function getNativeDaemonRelayUrl(): string | null {
  const serverUrl = getInjectedHtreeServerUrl();
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

export function getEffectiveNdkRelayUrls(relays: string[]): string[] {
  const nativeRelayUrl = getNativeDaemonRelayUrl();
  if (nativeRelayUrl) {
    return [nativeRelayUrl];
  }
  return uniqueRelayUrls(relays);
}

// Expose NDK on window for debugging
if (typeof window !== 'undefined') {
  (window as Window & { __ndk?: NDK }).__ndk = ndk;
}

/**
 * Unified sign function - works with both nsec and extension login
 */
export async function signEvent(event: NostrEvent): Promise<NostrEvent> {
  if (!ndk.signer) {
    throw new Error('No signing method available');
  }
  const ndkEvent = new NDKEvent(ndk, event);
  await ndkEvent.sign();
  return ndkEvent.rawEvent() as NostrEvent;
}

export async function configureNdkRelays(relays: string[], timeoutMs = 5000): Promise<void> {
  const normalized = getEffectiveNdkRelayUrls(relays);

  for (const relay of ndk.pool.relays.values()) {
    try {
      relay.disconnect();
    } catch {
      // Ignore disconnect errors while swapping relay sets.
    }
  }

  ndk.explicitRelayUrls = normalized;

  if (normalized.length === 0) {
    return;
  }

  const connectPromise = ndk.connect(timeoutMs);
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('Relay connect timeout')), timeoutMs);
  });

  await Promise.race([connectPromise, timeoutPromise]).catch(() => {
    // Native startup should continue even if relays are slow or unreachable.
  });
}

export function disconnectNdkRelays(): void {
  for (const relay of ndk.pool.relays.values()) {
    try {
      relay.disconnect();
    } catch {
      // Ignore disconnect errors during shutdown.
    }
  }
  ndk.explicitRelayUrls = [];
}

export function getNdkRelayStats(): Array<{
  url: string;
  connected: boolean;
  eventsReceived: number;
  eventsSent: number;
}> {
  return Array.from(ndk.pool.relays.values()).map((relay) => ({
    url: relay.url,
    connected: relay.status >= 5,
    eventsReceived: 0,
    eventsSent: 0,
  }));
}

export async function waitForNdkRelayConnection(maxWaitMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (getNdkRelayStats().some((relay) => relay.connected)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Re-export for convenience
export { NDKEvent, NDKPrivateKeySigner, NDKNip07Signer, type NostrEvent };
