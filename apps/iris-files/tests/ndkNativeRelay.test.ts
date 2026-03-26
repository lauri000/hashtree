import { afterEach, describe, expect, it, vi } from 'vitest';

function installWindow(serverUrl?: string): void {
  vi.stubGlobal('window', {
    location: {
      protocol: 'htree:',
      hostname: 'npub1example',
      search: '',
    },
    __HTREE_SERVER_URL__: serverUrl,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('native daemon relay selection', () => {
  it('routes native mode through only the embedded daemon websocket relay', async () => {
    installWindow('http://127.0.0.1:21417');
    const { getEffectiveNdkRelayUrls, getNativeDaemonRelayUrl } = await import('../src/nostr/ndk');

    expect(getNativeDaemonRelayUrl()).toBe('ws://127.0.0.1:21417/ws');
    expect(getEffectiveNdkRelayUrls(['wss://relay.example', 'wss://relay.example/'])).toEqual([
      'ws://127.0.0.1:21417/ws',
    ]);
  });

  it('keeps configured relay urls in non-native mode', async () => {
    installWindow();
    const { getEffectiveNdkRelayUrls, getNativeDaemonRelayUrl } = await import('../src/nostr/ndk');

    expect(getNativeDaemonRelayUrl()).toBeNull();
    expect(getEffectiveNdkRelayUrls(['wss://relay.example/', 'wss://relay.example', 'wss://relay.two']))
      .toEqual(['wss://relay.example', 'wss://relay.two']);
  });
});
