import { afterEach, describe, expect, it, vi } from 'vitest';

function installWindow(serverUrl?: string, search = ''): void {
  vi.stubGlobal('window', {
    location: {
      protocol: 'htree:',
      hostname: 'npub1example',
      search,
    },
    __HTREE_SERVER_URL__: serverUrl,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('runtime blossom server selection', () => {
  it('prepends the embedded daemon blossom endpoint and keeps upstream fallbacks', async () => {
    installWindow('http://127.0.0.1:21417');
    const { getEffectiveBlossomServers } = await import('../src/lib/runtimeNetwork');

    expect(getEffectiveBlossomServers([
      { url: 'https://upload.iris.to', read: false, write: true },
      { url: 'https://cdn.iris.to', read: true, write: false },
    ])).toEqual([
      { url: 'http://127.0.0.1:21417', read: true, write: true },
      { url: 'https://upload.iris.to', read: false, write: true },
      { url: 'https://cdn.iris.to', read: true, write: false },
    ]);
  });

  it('deduplicates a manually configured daemon blossom endpoint', async () => {
    installWindow(undefined, '?iris_htree_server=http%3A%2F%2F127.0.0.1%3A21417');
    const { getEffectiveBlossomServers } = await import('../src/lib/runtimeNetwork');

    expect(getEffectiveBlossomServers([
      { url: 'http://127.0.0.1:21417/', read: true, write: false },
      { url: 'https://upload.iris.to', read: false, write: true },
    ])).toEqual([
      { url: 'http://127.0.0.1:21417', read: true, write: true },
      { url: 'https://upload.iris.to', read: false, write: true },
    ]);
  });
});
