import { describe, it, expect } from 'vitest';
import { fromHex, toHex } from '@hashtree/core';
import { treeRootRegistry } from '../src/index';

const HASH_A = fromHex('11'.repeat(32));
const HASH_B = fromHex('33'.repeat(32));
const KEY_A = fromHex('22'.repeat(32));

describe('tree root registry same-hash merges', () => {
  it('merges key and visibility metadata from older worker updates when hash is unchanged', () => {
    const npub = 'npub-test-worker-merge';
    const treeName = 'boards/test-worker-merge';

    treeRootRegistry.delete(npub, treeName);
    treeRootRegistry.setFromExternal(npub, treeName, HASH_A, 'prefetch', {
      updatedAt: 200,
      visibility: 'public',
    });

    const updated = treeRootRegistry.setFromWorker(npub, treeName, HASH_A, 100, {
      key: KEY_A,
      visibility: 'link-visible',
      encryptedKey: 'aa'.repeat(32),
      keyId: 'key-id-1',
      selfEncryptedLinkKey: 'bb'.repeat(32),
    });

    expect(updated).toBe(true);
    const record = treeRootRegistry.get(npub, treeName);
    expect(record).not.toBeNull();
    expect(record?.hash && toHex(record.hash)).toBe(toHex(HASH_A));
    expect(record?.key && toHex(record.key)).toBe(toHex(KEY_A));
    expect(record?.visibility).toBe('link-visible');
    expect(record?.encryptedKey).toBe('aa'.repeat(32));
    expect(record?.keyId).toBe('key-id-1');
    expect(record?.selfEncryptedLinkKey).toBe('bb'.repeat(32));
  });

  it('still rejects older updates when the hash changes', () => {
    const npub = 'npub-test-older-hash';
    const treeName = 'boards/test-older-hash';

    treeRootRegistry.delete(npub, treeName);
    treeRootRegistry.setFromExternal(npub, treeName, HASH_A, 'prefetch', {
      updatedAt: 200,
      visibility: 'public',
    });

    const updated = treeRootRegistry.setFromWorker(npub, treeName, HASH_B, 100, {
      key: KEY_A,
      visibility: 'link-visible',
    });

    expect(updated).toBe(false);
    const record = treeRootRegistry.get(npub, treeName);
    expect(record).not.toBeNull();
    expect(record?.hash && toHex(record.hash)).toBe(toHex(HASH_A));
    expect(record?.key).toBeUndefined();
    expect(record?.visibility).toBe('public');
  });
});
