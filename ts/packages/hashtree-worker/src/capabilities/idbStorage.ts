import { fromHex, sha256, toHex } from '@hashtree/core';
import { DexieStore } from '@hashtree/dexie';

export interface StorageStats {
  items: number;
  bytes: number;
  maxBytes: number;
}

export class IdbBlobStorage {
  private readonly store: DexieStore;
  private maxBytes: number;

  constructor(dbName: string, maxBytes: number) {
    this.store = new DexieStore(dbName);
    this.maxBytes = maxBytes;
  }

  setMaxBytes(maxBytes: number): void {
    this.maxBytes = maxBytes;
  }

  getMaxBytes(): number {
    return this.maxBytes;
  }

  async put(data: Uint8Array): Promise<string> {
    const hashHex = toHex(await sha256(data));
    await this.store.put(fromHex(hashHex), data);
    await this.store.evict(this.maxBytes);
    return hashHex;
  }

  async putByHash(hashHex: string, data: Uint8Array): Promise<void> {
    const computed = toHex(await sha256(data));
    if (computed !== hashHex) {
      throw new Error('Hash mismatch while caching fetched blob');
    }
    await this.store.put(fromHex(hashHex), data);
    await this.store.evict(this.maxBytes);
  }

  async get(hashHex: string): Promise<Uint8Array | null> {
    return this.store.get(fromHex(hashHex));
  }

  async getStats(): Promise<StorageStats> {
    const [items, bytes] = await Promise.all([
      this.store.count(),
      this.store.totalBytes(),
    ]);
    return { items, bytes, maxBytes: this.maxBytes };
  }

  close(): void {
    this.store.close();
  }
}
