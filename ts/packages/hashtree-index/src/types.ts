import type { Hash, Store, CID } from '@hashtree/core';

export type { Hash, Store, CID };

export interface BTreeOptions {
  /** Max entries per node before splitting. Default: 32 */
  order?: number;
  /** Store tree nodes and leaf values without CHK encryption. */
  public?: boolean;
}
