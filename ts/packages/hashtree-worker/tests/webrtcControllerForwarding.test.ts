import { describe, expect, it } from 'vitest';
import { sha256, type Store } from '@hashtree/core';
import { createRequest, createResponse, encodeRequest, encodeResponse } from '@hashtree/nostr';
import { WebRTCController } from '../src/p2p/webrtcController.js';

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

function createForwardingController(localStore: Store): {
  controller: WebRTCController;
  internal: ControllerPrivateApi;
  sentData: Array<{ peerId: string; data: Uint8Array }>;
} {
  const sentData: Array<{ peerId: string; data: Uint8Array }> = [];
  const controller = new WebRTCController({
    pubkey: 'self-pubkey',
    localStore,
    sendCommand: (cmd) => {
      if (cmd.type === 'rtc:sendData') {
        sentData.push({ peerId: cmd.peerId, data: cmd.data });
      }
    },
    sendSignaling: async () => {},
    requestTimeout: 100,
  });

  const internal = controller as unknown as ControllerPrivateApi;
  return { controller, internal, sentData };
}

function connectPeer(internal: ControllerPrivateApi, peerId: string, pubkey: string): ControllerPeer {
  const peer = internal.createPeer(peerId, pubkey, 'other', 'outbound');
  peer.state = 'connected';
  peer.dataChannelReady = true;
  return peer;
}

describe('WebRTCController forwarding behavior', () => {
  it('suppresses duplicate forwarded queries while a hash lookup is in flight', async () => {
    const localStore: Store = {
      put: async () => true,
      get: async () => null,
      has: async () => false,
      delete: async () => false,
    };
    const { controller, internal, sentData } = createForwardingController(localStore);
    const requester = connectPeer(internal, 'peer-requester', 'requester-pubkey');
    const upstream = connectPeer(internal, 'peer-upstream', 'upstream-pubkey');

    const hash = new Uint8Array(32).fill(5);
    const requestBytes = new Uint8Array(encodeRequest(createRequest(hash, 3)));

    await internal.onDataChannelMessage(requester.peerId, requestBytes);
    await internal.onDataChannelMessage(requester.peerId, requestBytes);

    const forwardedToUpstream = sentData.filter((entry) => entry.peerId === upstream.peerId);
    expect(forwardedToUpstream).toHaveLength(1);

    const requesterStats = controller.getPeerStats().find((stats) => stats.peerId === requester.peerId);
    expect(requesterStats?.forwardedRequests).toBe(1);
    expect(requesterStats?.forwardedSuppressed).toBe(1);
  });

  it('counts forwarded-resolved queries when an upstream response is returned', async () => {
    const localStore: Store = {
      put: async () => true,
      get: async () => null,
      has: async () => false,
      delete: async () => false,
    };
    const { controller, internal, sentData } = createForwardingController(localStore);
    const requester = connectPeer(internal, 'peer-requester', 'requester-pubkey');
    const upstream = connectPeer(internal, 'peer-upstream', 'upstream-pubkey');

    const payload = new Uint8Array([10, 20, 30, 40]);
    const hash = await sha256(payload);
    const requestBytes = new Uint8Array(encodeRequest(createRequest(hash, 4)));
    await internal.onDataChannelMessage(requester.peerId, requestBytes);

    const responseBytes = new Uint8Array(encodeResponse(createResponse(hash, payload)));
    await internal.onDataChannelMessage(upstream.peerId, responseBytes);

    const responsesToRequester = sentData.filter((entry) => entry.peerId === requester.peerId);
    expect(responsesToRequester.length).toBeGreaterThan(0);

    const requesterStats = controller.getPeerStats().find((stats) => stats.peerId === requester.peerId);
    expect(requesterStats?.forwardedResolved).toBe(1);
  });
});
