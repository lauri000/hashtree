import { fromHex, toHex, type CID } from '@hashtree/core';
import type { SerializedCid } from './types.js';

export function serializeCid(cid: CID | null | undefined): SerializedCid | null {
  if (!cid?.hash) {
    return null;
  }

  return {
    hash: toHex(cid.hash),
    key: cid.key ? toHex(cid.key) : undefined,
  };
}

export function deserializeCid(cid: SerializedCid | null | undefined): CID | null {
  if (!cid?.hash) {
    return null;
  }

  return {
    hash: fromHex(cid.hash),
    key: cid.key ? fromHex(cid.key) : undefined,
  };
}
