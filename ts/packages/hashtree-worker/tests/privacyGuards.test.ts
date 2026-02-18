import { describe, expect, it } from 'vitest';
import { fromHex } from '@hashtree/core';
import {
  assertEncryptedUploadCid,
  markEncryptedHashes,
  shouldServeHashToPeer,
} from '../src/privacyGuards.js';

const TEST_HASH_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('privacyGuards', () => {
  describe('assertEncryptedUploadCid', () => {
    it('accepts CID with a 32-byte key', () => {
      expect(() => assertEncryptedUploadCid({
        hash: fromHex(TEST_HASH_HEX),
        key: fromHex(TEST_HASH_HEX),
      })).not.toThrow();
    });

    it('rejects CID without key', () => {
      expect(() => assertEncryptedUploadCid({
        hash: fromHex(TEST_HASH_HEX),
      })).toThrow('Refusing to upload unencrypted CID');
    });

    it('rejects CID with invalid key length', () => {
      expect(() => assertEncryptedUploadCid({
        hash: fromHex(TEST_HASH_HEX),
        key: new Uint8Array(31),
      })).toThrow('Refusing to upload CID with invalid encryption key');
    });
  });

  describe('peer share allowlist', () => {
    it('only serves hashes that have been explicitly marked encrypted', () => {
      const allowlist = new Set<string>();
      const hashA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const hashB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      markEncryptedHashes([hashA], allowlist);

      expect(shouldServeHashToPeer(hashA, allowlist)).toBe(true);
      expect(shouldServeHashToPeer(hashB, allowlist)).toBe(false);
    });
  });
});
