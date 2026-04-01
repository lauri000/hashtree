import { MemoryStore, fromHex, toHex } from '@hashtree/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearMemoryCache,
  getCachedRootInfo,
  initTreeRootCache,
  setCachedRoot,
} from '../src/iris/treeRootCache';

const HASH_A = fromHex('11'.repeat(32));
const KEY_A = fromHex('22'.repeat(32));

describe('treeRootCache', () => {
  beforeEach(() => {
    clearMemoryCache();
    initTreeRootCache(new MemoryStore());
  });

  it('preserves same-hash visibility metadata when a later cache sync omits it', async () => {
    const npub = 'npub-worker-cache-metadata';
    const treeName = 'boards/worker-cache-metadata';

    await setCachedRoot(npub, treeName, { hash: HASH_A, key: KEY_A }, 'link-visible', {
      updatedAt: 100,
      encryptedKey: 'aa'.repeat(32),
      keyId: 'key-id-3',
      selfEncryptedLinkKey: 'bb'.repeat(32),
    });

    await setCachedRoot(npub, treeName, { hash: HASH_A }, 'link-visible', {
      updatedAt: 200,
    });

    const cached = await getCachedRootInfo(npub, treeName);
    expect(cached).toBeTruthy();
    expect(cached?.key && toHex(cached.key)).toBe(toHex(KEY_A));
    expect(cached?.encryptedKey).toBe('aa'.repeat(32));
    expect(cached?.keyId).toBe('key-id-3');
    expect(cached?.selfEncryptedLinkKey).toBe('bb'.repeat(32));
  });
});
