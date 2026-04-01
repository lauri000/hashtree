import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, sha256 } from '@hashtree/core';
import { WebRTCController } from '../src/p2p/webrtcController.js';
import { createResponse, encodeResponse } from '@hashtree/nostr';

interface ControllerPeer {
  peerId: string;
  dataChannelReady: boolean;
  state: 'connecting' | 'connected' | 'disconnected';
}

interface ControllerPrivateApi {
  createPeer: (
    peerId: string,
    pubkey: string,
    pool: 'follows' | 'other',
    direction: 'inbound' | 'outbound'
  ) => ControllerPeer;
  onDataChannelMessage: (peerId: string, data: Uint8Array) => Promise<void>;
}

afterEach(() => {
  vi.useRealTimers();
});

function createRoutingController(options: {
  follows?: Set<string>;
  requestDispatch?: {
    initialFanout: number;
    hedgeFanout: number;
    maxFanout: number;
    hedgeIntervalMs: number;
  };
}) {
  const sentData: Array<{ peerId: string; data: Uint8Array }> = [];
  const controller = new WebRTCController({
    pubkey: 'self-pubkey',
    localStore: new MemoryStore(),
    sendCommand: (cmd) => {
      if (cmd.type === 'rtc:sendData') {
        sentData.push({ peerId: cmd.peerId, data: cmd.data });
      }
    },
    sendSignaling: async () => {},
    getFollows: () => options.follows ?? new Set<string>(),
    requestTimeout: 120,
    requestDispatch: options.requestDispatch,
  });
  return { controller, internal: controller as unknown as ControllerPrivateApi, sentData };
}

function connectPeer(
  internal: ControllerPrivateApi,
  peerId: string,
  pubkey: string,
  pool: 'follows' | 'other' = 'other'
): ControllerPeer {
  const peer = internal.createPeer(peerId, pubkey, pool, 'outbound');
  peer.state = 'connected';
  peer.dataChannelReady = true;
  return peer;
}

describe('WebRTCController routing', () => {
  it('sends staged hedged waves instead of flooding all peers immediately', async () => {
    vi.useFakeTimers();
    const { controller, internal, sentData } = createRoutingController({
      requestDispatch: {
        initialFanout: 2,
        hedgeFanout: 1,
        maxFanout: 4,
        hedgeIntervalMs: 50,
      },
    });

    connectPeer(internal, 'peer-a', 'pub-a');
    connectPeer(internal, 'peer-b', 'pub-b');
    connectPeer(internal, 'peer-c', 'pub-c');
    connectPeer(internal, 'peer-d', 'pub-d');

    const hash = await sha256(new TextEncoder().encode('route-me'));
    const pending = controller.get(hash);

    await vi.advanceTimersByTimeAsync(0);
    expect(sentData).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(49);
    expect(sentData).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(sentData).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(50);
    expect(sentData).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeNull();
  });

  it('prioritizes follows pool peers first', async () => {
    vi.useFakeTimers();
    const follows = new Set<string>(['followed-pub']);
    const { controller, internal, sentData } = createRoutingController({
      follows,
      requestDispatch: {
        initialFanout: 1,
        hedgeFanout: 1,
        maxFanout: 2,
        hedgeIntervalMs: 100,
      },
    });

    connectPeer(internal, 'peer-other', 'other-pub', 'other');
    const followed = connectPeer(internal, 'peer-followed', 'followed-pub', 'follows');

    const hash = await sha256(new TextEncoder().encode('prefer-follows'));
    const pending = controller.get(hash);

    await vi.advanceTimersByTimeAsync(0);
    expect(sentData[0]?.peerId).toBe(followed.peerId);

    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeNull();
  });

  it('persists and reloads peer metadata snapshots', async () => {
    const localStore = new MemoryStore();

    const first = new WebRTCController({
      pubkey: 'self-pubkey',
      localStore,
      sendCommand: () => {},
      sendSignaling: async () => {},
    });
    const selector1 = (first as any).peerSelector;
    selector1.addPeer('fav-pub');
    selector1.recordRequest('fav-pub', 32);
    selector1.recordSuccess('fav-pub', 12, 1024);

    const hash = await first.persistPeerMetadata();
    expect(hash).not.toBeNull();

    const second = new WebRTCController({
      pubkey: 'self-pubkey',
      localStore,
      sendCommand: () => {},
      sendSignaling: async () => {},
    });

    const loaded = await second.loadPeerMetadata();
    expect(loaded).toBe(true);

    const selector2 = (second as any).peerSelector;
    selector2.addPeer('fav-pub');
    selector2.addPeer('other-pub');
    const ordered = selector2.selectPeers();
    expect(ordered[0]).toBe('fav-pub');
  });

  it('promotes previously successful peers on subsequent lookups', async () => {
    vi.useFakeTimers();
    const { controller, internal, sentData } = createRoutingController({
      requestDispatch: {
        initialFanout: 1,
        hedgeFanout: 1,
        maxFanout: 2,
        hedgeIntervalMs: 100,
      },
    });

    connectPeer(internal, 'peer-a', 'pub-a');
    connectPeer(internal, 'peer-b', 'pub-b');

    const payload = new TextEncoder().encode('winner');
    const hash1 = await sha256(payload);

    const firstGet = controller.get(hash1);
    await vi.advanceTimersByTimeAsync(0);
    const firstPeer = sentData[0]?.peerId;
    expect(firstPeer).toBeDefined();

    const response = new Uint8Array(encodeResponse(createResponse(hash1, payload)));
    await internal.onDataChannelMessage(firstPeer!, response);
    await expect(firstGet).resolves.toEqual(payload);

    sentData.length = 0;
    const hash2 = await sha256(new TextEncoder().encode('second-request'));
    const secondGet = controller.get(hash2);
    await vi.advanceTimersByTimeAsync(0);

    expect(sentData[0]?.peerId).toBe(firstPeer);

    await vi.advanceTimersByTimeAsync(500);
    await expect(secondGet).resolves.toBeNull();
  });
});
