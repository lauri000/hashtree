import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@hashtree/core';
import { WebRTCController } from '../src/p2p/webrtcController.js';

describe('WebRTCController idle signaling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts hello immediately and every 5 seconds while started', async () => {
    let helloCount = 0;
    const localStore: Store = {
      put: async () => true,
      get: async () => null,
      has: async () => false,
      delete: async () => false,
    };

    const controller = new WebRTCController({
      pubkey: 'self-pubkey',
      localStore,
      sendCommand: () => {},
      sendSignaling: async (msg) => {
        if (msg.type === 'hello') {
          helloCount += 1;
        }
      },
    });

    controller.start();
    expect(helloCount).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(helloCount).toBe(4);

    controller.stop();
  });
});
