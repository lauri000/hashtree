import { afterEach, describe, expect, it, vi } from 'vitest';

type MemoryStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function createMemoryStorage(): MemoryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('client id helpers', () => {
  it('persists and reuses a generated client id for the same storage key', async () => {
    const storage = createMemoryStorage();
    const { getOrCreateHtreeClientId } = await import('../src/client-id');

    const first = getOrCreateHtreeClientId({
      storage,
      storageKey: 'iris-audio.mediaClientId',
      uuidFactory: () => 'client-1',
    });
    const second = getOrCreateHtreeClientId({
      storage,
      storageKey: 'iris-audio.mediaClientId',
      uuidFactory: () => 'client-2',
    });

    expect(first).toBe('client-1');
    expect(second).toBe('client-1');
    expect(storage.getItem('iris-audio.mediaClientId')).toBe('client-1');
  });

  it('returns null when there is no browser-like runtime or injected storage', async () => {
    const { getOrCreateHtreeClientId } = await import('../src/client-id');

    expect(getOrCreateHtreeClientId()).toBeNull();
  });

  it('appends htree_c to relative htree urls without forcing them absolute', async () => {
    const { appendHtreeClientId } = await import('../src/client-id');

    expect(appendHtreeClientId('/htree/nhash1example/video.mp4', 'client-1', {
      baseOrigin: 'https://audio.iris.to',
    })).toBe('/htree/nhash1example/video.mp4?htree_c=client-1');

    expect(appendHtreeClientId('/htree/nhash1example/video.mp4?download=1', 'client-1', {
      baseOrigin: 'https://audio.iris.to',
    })).toBe('/htree/nhash1example/video.mp4?download=1&htree_c=client-1');
  });
});
