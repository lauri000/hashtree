import { describe, it, expect } from 'vitest';
import { toHex } from '@hashtree/core';
import { parseHtreeVisibility, resolveHtreeRootCid } from '../src/index.js';

const ROOT_HASH_HEX = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeBytes(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  out.fill(seed);
  return out;
}

describe('htree event helpers', () => {
  it('parses visibility from tags', () => {
    const publicInfo = parseHtreeVisibility([['hash', ROOT_HASH_HEX], ['key', 'ff'.repeat(32)]]);
    expect(publicInfo.visibility).toBe('public');

    const linkInfo = parseHtreeVisibility([['hash', ROOT_HASH_HEX], ['encryptedKey', 'ff'.repeat(32)], ['keyId', '11'.repeat(8)]]);
    expect(linkInfo.visibility).toBe('link-visible');
    expect(linkInfo.keyId).toBe('11'.repeat(8));

    const privateInfo = parseHtreeVisibility([['hash', ROOT_HASH_HEX], ['selfEncryptedKey', 'enc']]);
    expect(privateInfo.visibility).toBe('private');
  });

  it('resolves public root cid', async () => {
    const key = makeBytes(3);
    const tags = [
      ['hash', ROOT_HASH_HEX],
      ['key', toHex(key)],
    ];

    const cid = await resolveHtreeRootCid({ tags });
    expect(toHex(cid.hash)).toBe(ROOT_HASH_HEX);
    expect(cid.key).toEqual(key);
  });

  it('resolves public root cid from content when hash tag missing', async () => {
    const key = makeBytes(4);
    const tags = [['key', toHex(key)]];

    const cid = await resolveHtreeRootCid({ tags, content: ROOT_HASH_HEX });
    expect(toHex(cid.hash)).toBe(ROOT_HASH_HEX);
    expect(cid.key).toEqual(key);
  });

  it('resolves link-visible root cid', async () => {
    const linkKey = makeBytes(5);
    const rootKey = makeBytes(9);
    const masked = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      masked[i] = rootKey[i] ^ linkKey[i];
    }

    const tags = [
      ['hash', ROOT_HASH_HEX],
      ['encryptedKey', toHex(masked)],
    ];

    const cid = await resolveHtreeRootCid({ tags, linkKey });
    expect(toHex(cid.hash)).toBe(ROOT_HASH_HEX);
    expect(cid.key).toEqual(rootKey);
  });

  it('rejects link-visible without link key', async () => {
    const tags = [
      ['hash', ROOT_HASH_HEX],
      ['encryptedKey', toHex(makeBytes(7))],
    ];

    await expect(resolveHtreeRootCid({ tags })).rejects.toThrow('secret key');
  });

  it('resolves private root cid using decrypt callback', async () => {
    const rootKey = makeBytes(11);
    const tags = [
      ['hash', ROOT_HASH_HEX],
      ['selfEncryptedKey', 'ciphertext'],
    ];

    const cid = await resolveHtreeRootCid({
      tags,
      requirePrivate: true,
      decryptSelfKey: async () => toHex(rootKey),
    });

    expect(toHex(cid.hash)).toBe(ROOT_HASH_HEX);
    expect(cid.key).toEqual(rootKey);
  });

  it('rejects private root cid without decrypt callback', async () => {
    const tags = [
      ['hash', ROOT_HASH_HEX],
      ['selfEncryptedKey', 'ciphertext'],
    ];

    await expect(resolveHtreeRootCid({ tags, requirePrivate: true })).rejects.toThrow('Decrypt callback');
  });

  it('throws if private tag but not marked private', async () => {
    const tags = [
      ['hash', ROOT_HASH_HEX],
      ['selfEncryptedKey', 'ciphertext'],
    ];

    await expect(resolveHtreeRootCid({ tags })).rejects.toThrow('private');
  });

  it('validates hash hex', async () => {
    const tags = [
      ['hash', 'not-hex'],
    ];

    await expect(resolveHtreeRootCid({ tags })).rejects.toThrow('root hash');
  });

  it('rejects invalid decrypted key length', async () => {
    const tags = [
      ['hash', ROOT_HASH_HEX],
      ['selfEncryptedKey', 'ciphertext'],
    ];

    await expect(resolveHtreeRootCid({
      tags,
      requirePrivate: true,
      decryptSelfKey: async () => 'ff',
    })).rejects.toThrow('decrypted');
  });

  it('accepts decrypt callback returning bytes', async () => {
    const rootKey = makeBytes(12);
    const tags = [
      ['hash', ROOT_HASH_HEX],
      ['selfEncryptedKey', 'ciphertext'],
    ];

    const cid = await resolveHtreeRootCid({
      tags,
      requirePrivate: true,
      decryptSelfKey: async () => rootKey,
    });

    expect(cid.key).toEqual(rootKey);
  });
});
