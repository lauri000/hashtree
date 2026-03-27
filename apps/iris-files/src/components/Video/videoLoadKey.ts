import { toHex, type CID } from '@hashtree/core';

export function buildVideoLoadKey(rootCid: CID | null | undefined, path: string): string {
  const hashKey = rootCid ? toHex(rootCid.hash) : 'no-root';
  const encryptionKey = rootCid?.key ? toHex(rootCid.key) : '';
  return `${hashKey}:${encryptionKey}:${path}`;
}
