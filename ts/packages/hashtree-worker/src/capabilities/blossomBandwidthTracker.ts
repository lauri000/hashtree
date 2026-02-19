import type { BlossomLogEntry } from '@hashtree/core';

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

export class BlossomBandwidthTracker {
  private totalBytesSent = 0;
  private totalBytesReceived = 0;
  private readonly serverBandwidth = new Map<string, { bytesSent: number; bytesReceived: number }>();
  private readonly onUpdate?: BlossomBandwidthUpdateHandler;
  private readonly now: () => number;

  constructor(onUpdate?: BlossomBandwidthUpdateHandler, now: () => number = () => Date.now()) {
    this.onUpdate = onUpdate;
    this.now = now;
  }

  apply(entry: BlossomLogEntry): void {
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
    this.onUpdate?.(this.getStats());
  }

  getStats(): BlossomBandwidthStats {
    return {
      totalBytesSent: this.totalBytesSent,
      totalBytesReceived: this.totalBytesReceived,
      updatedAt: this.now(),
      servers: this.getOrderedServerBandwidth(),
    };
  }

  reset(): void {
    this.totalBytesSent = 0;
    this.totalBytesReceived = 0;
    this.serverBandwidth.clear();
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
}
