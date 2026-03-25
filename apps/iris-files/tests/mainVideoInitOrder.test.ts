import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mount = vi.fn();
const initServiceWorker = vi.fn();
const initReadonlyBackend = vi.fn();
const restoreSession = vi.fn();
const initHtreeApi = vi.fn();
const mergeBootstrapIndex = vi.fn();
const setAppType = vi.fn();
const installHtreeDebugCapture = vi.fn();

async function waitForExpectation(expectation: () => void, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      expectation();
      return;
    } catch (error) {
      lastError = error;
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe('main-video init order', () => {
  beforeEach(() => {
    vi.resetModules();
    mount.mockReset();
    initServiceWorker.mockReset();
    initReadonlyBackend.mockReset();
    restoreSession.mockReset();
    initHtreeApi.mockReset();
    mergeBootstrapIndex.mockReset();
    setAppType.mockReset();
    installHtreeDebugCapture.mockReset();
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => ({ id: 'app' })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('waits for the service worker before mounting the video app', async () => {
    let resolveSw: (() => void) | null = null;
    const swReady = new Promise<void>((resolve) => {
      resolveSw = resolve;
    });

    initServiceWorker.mockReturnValue(swReady);
    initReadonlyBackend.mockResolvedValue(undefined);
    restoreSession.mockResolvedValue(undefined);
    initHtreeApi.mockResolvedValue(undefined);
    mergeBootstrapIndex.mockResolvedValue(undefined);

    vi.doMock('svelte', () => ({ mount }));
    vi.doMock('../src/lib/swInit', () => ({ initServiceWorker }));
    vi.doMock('../src/nostr/auth', () => ({ initReadonlyBackend, restoreSession }));
    vi.doMock('../src/stores/searchIndex', () => ({ mergeBootstrapIndex }));
    vi.doMock('../src/appType', () => ({ setAppType }));
    vi.doMock('../src/lib/htreeApi', () => ({ initHtreeApi }));
    vi.doMock('../src/lib/htreeDebug', () => ({ installHtreeDebugCapture }));
    vi.doMock('../src/VideoApp.svelte', () => ({ default: {} }));

    await import('../src/main-video');
    await Promise.resolve();

    expect(initServiceWorker).toHaveBeenCalledOnce();
    expect(mount).not.toHaveBeenCalled();

    resolveSw?.();

    await waitForExpectation(() => {
      expect(mount).toHaveBeenCalledOnce();
    });
    await waitForExpectation(() => {
      expect(mergeBootstrapIndex).toHaveBeenCalledOnce();
    });
  });
});
