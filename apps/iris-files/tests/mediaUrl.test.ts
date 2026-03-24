import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromHex, nhashEncode } from '@hashtree/core';
import { getThumbnailUrlFromCid } from '../src/lib/mediaUrl';

afterEach(() => {
  vi.unstubAllGlobals();
});

function installWindow(): void {
  vi.stubGlobal('window', {
    location: {
      protocol: 'http:',
      hostname: '127.0.0.1',
      search: '',
    },
  });
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-media-client',
  });
}

describe('mediaUrl thumbnail helpers', () => {
  it('builds immutable thumbnail urls from a known root cid', () => {
    installWindow();
    const rootCid = {
      hash: fromHex('1'.repeat(64)),
      key: fromHex('2'.repeat(64)),
    };

    expect(getThumbnailUrlFromCid(rootCid)).toBe(
      `/htree/${nhashEncode(rootCid)}/thumbnail?htree_c=test-media-client`,
    );
  });

  it('encodes nested playlist thumbnail paths for immutable urls', () => {
    installWindow();
    const rootCid = {
      hash: fromHex('3'.repeat(64)),
    };

    expect(getThumbnailUrlFromCid(rootCid, 'clips/demo reel')).toBe(
      `/htree/${nhashEncode(rootCid)}/clips/demo%20reel/thumbnail?htree_c=test-media-client`,
    );
  });
});
