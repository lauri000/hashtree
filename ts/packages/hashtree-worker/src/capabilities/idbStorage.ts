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
  private writesSinceEviction = 0;
  private evictionPromise: Promise<void> | null = null;

  private static readonly EVICTION_WRITE_INTERVAL = 32;

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
    void this.scheduleEviction();
    return hashHex;
  }

  async putByHash(hashHex: string, data: Uint8Array): Promise<void> {
    const computed = toHex(await sha256(data));
    if (computed !== hashHex) {
      throw new Error('Hash mismatch while caching fetched blob');
    }
    await this.store.put(fromHex(hashHex), data);
    void this.scheduleEviction();
  }

  async putByHashTrusted(hashHex: string, data: Uint8Array): Promise<void> {
    await this.store.put(fromHex(hashHex), data);
    void this.scheduleEviction();
  }

  async get(hashHex: string): Promise<Uint8Array | null> {
    return this.store.get(fromHex(hashHex));
  }

  async has(hashHex: string): Promise<boolean> {
    return this.store.has(fromHex(hashHex));
  }

  async delete(hashHex: string): Promise<boolean> {
    return this.store.delete(fromHex(hashHex));
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

  private scheduleEviction(): void {
    this.writesSinceEviction += 1;
    if (this.writesSinceEviction < IdbBlobStorage.EVICTION_WRITE_INTERVAL) {
      return;
    }
    this.writesSinceEviction = 0;

    if (this.evictionPromise) {
      return;
    }

    this.evictionPromise = this.store
      .evict(this.maxBytes)
      .then(() => {})
      .finally(() => {
        this.evictionPromise = null;
      });
  }
}
