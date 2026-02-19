import {
  BlossomStore,
  type BlossomLogEntry,
  type BlossomSigner,
  type BlossomUploadCallback,
  sha256,
  toHex,
  fromHex,
} from '@hashtree/core';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { BlossomServerConfig } from '../protocol.js';

export const DEFAULT_BLOSSOM_SERVERS: BlossomServerConfig[] = [
  { url: 'https://blossom.primal.net', read: true, write: true },
  { url: 'https://upload.iris.to', read: false, write: true },
];

export interface BlossomBandwidthServerStats {
  url: string;
  bytesSent: number;
  bytesReceived: number;
}

export interface BlossomBandwidthStats {
  totalBytesSent: number;
  totalBytesReceived: number;
  updatedAt: number;
  servers: BlossomBandwidthServerStats[];
}

export type BlossomBandwidthUpdateHandler = (stats: BlossomBandwidthStats) => void;

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

export class BlossomTransport {
  private servers: BlossomServerConfig[];
  private readonly signer: BlossomSigner;
  private readonly onBandwidthUpdate?: BlossomBandwidthUpdateHandler;
  private totalBytesSent = 0;
  private totalBytesReceived = 0;
  private readonly serverBandwidth = new Map<string, { bytesSent: number; bytesReceived: number }>();
  private store: BlossomStore;

  constructor(servers?: BlossomServerConfig[], onBandwidthUpdate?: BlossomBandwidthUpdateHandler) {
    this.servers = normalizeServers(servers);
    this.signer = createEphemeralSigner();
    this.onBandwidthUpdate = onBandwidthUpdate;
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
    return {
      totalBytesSent: this.totalBytesSent,
      totalBytesReceived: this.totalBytesReceived,
      updatedAt: Date.now(),
      servers: this.getOrderedServerBandwidth(),
    };
  }

  private getOrderedServerBandwidth(): BlossomBandwidthServerStats[] {
    return Array.from(this.serverBandwidth.entries())
      .map(([url, stats]) => ({
        url,
        bytesSent: stats.bytesSent,
        bytesReceived: stats.bytesReceived,
      }))
      .sort((a, b) => a.url.localeCompare(b.url));
  }

  private applyBandwidthLog(entry: BlossomLogEntry): void {
    const bytes = entry.bytes ?? 0;
    if (!entry.success || bytes <= 0) return;

    const serverStats = this.serverBandwidth.get(entry.server) ?? { bytesSent: 0, bytesReceived: 0 };

    if (entry.operation === 'put') {
      this.totalBytesSent += bytes;
      serverStats.bytesSent += bytes;
    } else if (entry.operation === 'get') {
      this.totalBytesReceived += bytes;
      serverStats.bytesReceived += bytes;
    } else {
      return;
    }

    this.serverBandwidth.set(entry.server, serverStats);

    if (this.onBandwidthUpdate) {
      this.onBandwidthUpdate({
        totalBytesSent: this.totalBytesSent,
        totalBytesReceived: this.totalBytesReceived,
        updatedAt: Date.now(),
        servers: this.getOrderedServerBandwidth(),
      });
    }
  }

  private createStore(servers: BlossomServerConfig[], onUploadProgress?: BlossomUploadCallback): BlossomStore {
    return new BlossomStore({
      servers,
      signer: this.signer,
      onUploadProgress,
      logger: (entry) => {
        this.applyBandwidthLog(entry);
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
    const readServers = this.servers.filter(server => server.read !== false);
    for (const server of readServers) {
      const baseUrl = normalizeServerUrl(server.url);
      const data = await this.fetchFromServer(baseUrl, hashHex);
      if (data) return data;
    }
    return null;
  }

  private async fetchFromServer(baseUrl: string, hashHex: string): Promise<Uint8Array | null> {
    const urls = [`${baseUrl}/${hashHex}`, `${baseUrl}/${hashHex}.bin`];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = new Uint8Array(await res.arrayBuffer());
        const verified = toHex(await sha256(data)) === hashHex;
        if (verified) return data;
      } catch {
        continue;
      }
    }
    return null;
  }
}
