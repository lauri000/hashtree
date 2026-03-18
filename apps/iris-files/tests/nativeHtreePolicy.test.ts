import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registerSWMock = vi.fn(() => vi.fn());

vi.mock('virtual:pwa-register', () => ({
  registerSW: registerSWMock,
}));

type WindowLike = {
  location: {
    protocol: string;
    hostname: string;
  };
  __HTREE_SERVER_URL__?: string;
  htree?: {
    htreeBaseUrl?: string;
  };
};

function installWindow(protocol: string, hostname: string, serverUrl?: string): void {
  const storage = new Map<string, string>();
  const windowLike: WindowLike = {
    location: { protocol, hostname },
  };
  if (serverUrl) {
    windowLike.__HTREE_SERVER_URL__ = serverUrl;
  }

  vi.stubGlobal('window', windowLike);
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
  });
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-client-id',
  });
}

function installServiceWorker(): void {
  const controller = {
    postMessage: vi.fn(),
  };
  vi.stubGlobal('navigator', {
    serviceWorker: {
      controller,
      ready: Promise.resolve({ active: controller }),
      getRegistrations: vi.fn(async () => []),
      addEventListener: vi.fn(),
    },
  });
  vi.stubGlobal('self', { crossOriginIsolated: false });
}

describe('native htree policy', () => {
  beforeEach(() => {
    vi.resetModules();
    registerSWMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps same-origin /htree routes on https pages even when Iris injects a local daemon URL', async () => {
    installWindow('https:', 'video.iris.to', 'http://127.0.0.1:21417');

    const nativeHtree = await import('../src/lib/nativeHtree');
    const mediaUrl = await import('../src/lib/mediaUrl');

    expect(nativeHtree.getInjectedHtreeServerUrl()).toBe('http://127.0.0.1:21417');
    expect(nativeHtree.canUseInjectedHtreeServerUrl()).toBe(false);
    expect(nativeHtree.shouldPreferSameOriginHtreeRoutes()).toBe(true);
    expect(mediaUrl.getHtreePrefix()).toBe('');

    const videoUrl = mediaUrl.getNpubFileUrl('npub1example', 'videos/Test Clip', 'video.mp4');
    expect(videoUrl.startsWith('/htree/npub1example/videos%2FTest%20Clip/video.mp4')).toBe(true);
  });

  it('still uses the injected daemon URL on native http pages', async () => {
    installWindow('http:', '127.0.0.1', 'http://127.0.0.1:21417');

    const nativeHtree = await import('../src/lib/nativeHtree');
    const mediaUrl = await import('../src/lib/mediaUrl');

    expect(nativeHtree.canUseInjectedHtreeServerUrl()).toBe(true);
    expect(nativeHtree.shouldPreferSameOriginHtreeRoutes()).toBe(false);
    expect(mediaUrl.getHtreePrefix()).toBe('http://127.0.0.1:21417');
  });

  it('registers the service worker on https pages instead of skipping it', async () => {
    installWindow('https:', 'video.iris.to', 'http://127.0.0.1:21417');
    installServiceWorker();

    const { initServiceWorker } = await import('../src/lib/swInit');
    await initServiceWorker();

    expect(registerSWMock).toHaveBeenCalledTimes(1);
  });

  it('skips the service worker only when the injected daemon URL is safe to use directly', async () => {
    installWindow('http:', '127.0.0.1', 'http://127.0.0.1:21417');
    installServiceWorker();

    const { initServiceWorker } = await import('../src/lib/swInit');
    await initServiceWorker();

    expect(registerSWMock).not.toHaveBeenCalled();
  });
});
