import { describe, expect, it } from 'vitest';
import type { BlossomLogEntry } from '@hashtree/core';
import { BlossomBandwidthTracker } from '../src/capabilities/blossomBandwidthTracker.js';

function entry(overrides: Partial<BlossomLogEntry>): BlossomLogEntry {
  return {
    timestamp: 1700000000000,
    operation: 'get',
    server: 'https://blossom.example',
    hash: 'abcd',
    success: true,
    ...overrides,
  };
}

describe('BlossomBandwidthTracker', () => {
  it('tracks upload/download totals and per-server bytes from log entries', () => {
    const updates: Array<{ sent: number; received: number }> = [];
    const tracker = new BlossomBandwidthTracker((stats) => {
      updates.push({ sent: stats.totalBytesSent, received: stats.totalBytesReceived });
    }, () => 1700000000123);

    tracker.apply(entry({ operation: 'put', bytes: 1024, server: 'https://upload.iris.to' }));
    tracker.apply(entry({ operation: 'get', bytes: 2048, server: 'https://blossom.primal.net' }));

    const stats = tracker.getStats();
    expect(stats.totalBytesSent).toBe(1024);
    expect(stats.totalBytesReceived).toBe(2048);
    expect(stats.updatedAt).toBe(1700000000123);
    expect(stats.servers).toEqual([
      { url: 'https://blossom.primal.net', bytesSent: 0, bytesReceived: 2048 },
      { url: 'https://upload.iris.to', bytesSent: 1024, bytesReceived: 0 },
    ]);
    expect(updates).toEqual([
      { sent: 1024, received: 0 },
      { sent: 1024, received: 2048 },
    ]);
  });

  it('ignores unsuccessful/zero-byte entries and can reset', () => {
    const tracker = new BlossomBandwidthTracker(undefined, () => 1700000000999);

    tracker.apply(entry({ operation: 'put', bytes: 512, server: 'https://a' }));
    tracker.apply(entry({ operation: 'put', success: false, bytes: 2048, server: 'https://a' }));
    tracker.apply(entry({ operation: 'get', bytes: 0, server: 'https://a' }));

    expect(tracker.getStats()).toEqual({
      totalBytesSent: 512,
      totalBytesReceived: 0,
      updatedAt: 1700000000999,
      servers: [{ url: 'https://a', bytesSent: 512, bytesReceived: 0 }],
    });

    tracker.reset();

    expect(tracker.getStats()).toEqual({
      totalBytesSent: 0,
      totalBytesReceived: 0,
      updatedAt: 1700000000999,
      servers: [],
    });
  });
});
