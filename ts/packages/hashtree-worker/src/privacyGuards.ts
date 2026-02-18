import type { CID } from '@hashtree/core';

const ENCRYPTION_KEY_BYTES = 32;

/**
 * Uploads must always point to encrypted content CIDs.
 */
export function assertEncryptedUploadCid(cid: CID): void {
  if (!cid.key) {
    throw new Error('Refusing to upload unencrypted CID');
  }
  if (cid.key.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error('Refusing to upload CID with invalid encryption key');
  }
}

/**
 * Mark known-encrypted block hashes as safe for peer serving.
 */
export function markEncryptedHashes(hashes: Iterable<string>, allowlist: Set<string>): void {
  for (const hashHex of hashes) {
    allowlist.add(hashHex.toLowerCase());
  }
}

/**
 * Peer responses are restricted to hashes explicitly marked as encrypted.
 */
export function shouldServeHashToPeer(hashHex: string, allowlist: ReadonlySet<string>): boolean {
  return allowlist.has(hashHex.toLowerCase());
}
