import {
  BlossomStore,
  type BlossomSigner,
  type BlossomUploadCallback,
  sha256,
  toHex,
  fromHex,
} from '@hashtree/core';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { BlossomServerConfig } from '../protocol.js';
import {
  BlossomBandwidthTracker,
  type BlossomBandwidthStats,
  type BlossomBandwidthUpdateHandler,
} from './blossomBandwidthTracker.js';

export const DEFAULT_BLOSSOM_SERVERS: BlossomServerConfig[] = [
  { url: 'https://cdn.iris.to', read: true, write: false },
  { url: 'https://hashtree.iris.to', read: true, write: false },
  { url: 'https://blossom.primal.net', read: true, write: false },
  { url: 'https://upload.iris.to', read: false, write: true },
];

const READ_FETCH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_READ_FETCHES = 12;

let activeReadFetches = 0;
const pendingReadFetchWaiters: Array<() => void> = [];

export type {
  BlossomBandwidthServerStats,
  BlossomBandwidthStats,
  BlossomBandwidthUpdateHandler,
} from './blossomBandwidthTracker.js';

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function normalizeServers(servers: BlossomServerConfig[] | undefined): BlossomServerConfig[] {
  const source = servers && servers.length > 0 ? servers : DEFAULT_BLOSSOM_SERVERS;
  const unique = new Map<string, BlossomServerConfig>();
  for (const server of source) {
    const url = normalizeServerUrl(server.url.trim());
    if (!url) continue;
    unique.set(url, {
      url,
      read: server.read ?? true,
      write: server.write ?? false,
    });
  }
  return Array.from(unique.values());
}

function createEphemeralSigner(): BlossomSigner {
  const secretKey = generateSecretKey();
  return async (template) => {
    const event = finalizeEvent({
      ...template,
      kind: template.kind as 24242,
      created_at: template.created_at,
      content: template.content,
      tags: template.tags,
    }, secretKey);
    return {
      kind: event.kind,
      created_at: event.created_at,
      content: event.content,
      tags: event.tags,
      pubkey: event.pubkey,
      id: event.id,
      sig: event.sig,
    };
  };
}

function releaseReadFetchSlot(): void {
  activeReadFetches = Math.max(0, activeReadFetches - 1);
  pendingReadFetchWaiters.shift()?.();
}

function withReadFetchSlot<T>(loader: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      activeReadFetches += 1;
      let pending: Promise<T>;
      try {
        pending = loader();
      } catch (error) {
        releaseReadFetchSlot();
        reject(error);
        return;
      }

      pending
        .then(resolve, reject)
        .finally(() => {
          releaseReadFetchSlot();
        });
    };

    if (activeReadFetches < MAX_CONCURRENT_READ_FETCHES) {
      start();
      return;
    }

    pendingReadFetchWaiters.push(start);
  });
}

export class BlossomTransport {
  private servers: BlossomServerConfig[];
  private readonly signer: BlossomSigner;
  private readonly bandwidthTracker: BlossomBandwidthTracker;
  private readonly inflightFetches = new Map<string, Promise<Uint8Array | null>>();
  private store: BlossomStore;

  constructor(servers?: BlossomServerConfig[], onBandwidthUpdate?: BlossomBandwidthUpdateHandler) {
    this.servers = normalizeServers(servers);
    this.signer = createEphemeralSigner();
    this.bandwidthTracker = new BlossomBandwidthTracker(onBandwidthUpdate);
    this.store = this.createStore(this.servers);
  }

  setServers(servers: BlossomServerConfig[]): void {
    this.servers = normalizeServers(servers);
    this.store = this.createStore(this.servers);
  }

  getServers(): BlossomServerConfig[] {
    return this.servers;
  }

  getWriteServers(): BlossomServerConfig[] {
    return this.servers.filter(server => !!server.write);
  }

  getBandwidthStats(): BlossomBandwidthStats {
    return this.bandwidthTracker.getStats();
  }

  private createStore(servers: BlossomServerConfig[], onUploadProgress?: BlossomUploadCallback): BlossomStore {
    return new BlossomStore({
      servers,
      signer: this.signer,
      onUploadProgress,
      logger: (entry) => {
        this.bandwidthTracker.apply(entry);
      },
    });
  }

  createUploadStore(onUploadProgress?: BlossomUploadCallback): BlossomStore {
    return this.createStore(this.servers, onUploadProgress);
  }

  async upload(
    hashHex: string,
    data: Uint8Array,
    _mimeType?: string,
    onUploadProgress?: BlossomUploadCallback
  ): Promise<void> {
    if (!this.servers.some(server => server.write)) return;
    const uploadMimeType = 'application/octet-stream';
    if (onUploadProgress) {
      const store = this.createStore(this.servers, onUploadProgress);
      await store.put(fromHex(hashHex), data, uploadMimeType);
      return;
    }

    await this.store.put(fromHex(hashHex), data, uploadMimeType);
  }

  async fetch(hashHex: string): Promise<Uint8Array | null> {
    const inflight = this.inflightFetches.get(hashHex);
    if (inflight) {
      return inflight;
    }

    const pending = this.fetchFromReadServers(hashHex)
      .finally(() => {
        this.inflightFetches.delete(hashHex);
      });
    this.inflightFetches.set(hashHex, pending);
    return await pending;
  }

  private async fetchFromReadServers(hashHex: string): Promise<Uint8Array | null> {
    const readServers = this.servers.filter(server => server.read !== false);
    if (readServers.length === 0) {
      return null;
    }

    const pendingFetches = readServers.map((server) =>
      this.fetchFromServer(normalizeServerUrl(server.url), hashHex)
    );

    return await new Promise<Uint8Array | null>((resolve) => {
      let settled = false;
      let remaining = pendingFetches.length;

      for (const fetchPromise of pendingFetches) {
        fetchPromise
          .then((result) => {
            if (settled) return;
            if (result) {
              settled = true;
              resolve(result);
              return;
            }

            remaining -= 1;
            if (remaining === 0) {
              resolve(null);
            }
          })
          .catch(() => {
            if (settled) return;
            remaining -= 1;
            if (remaining === 0) {
              resolve(null);
            }
          });
      }
    });
  }

  private async fetchFromServer(baseUrl: string, hashHex: string): Promise<Uint8Array | null> {
    return await withReadFetchSlot(async () => {
      const url = `${baseUrl}/${hashHex}.bin`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), READ_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        const data = new Uint8Array(await res.arrayBuffer());
        const verified = toHex(await sha256(data)) === hashHex;
        return verified ? data : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}
