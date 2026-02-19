import { describe, expect, it } from 'vitest';
import type { Store } from '@hashtree/core';
import { createRequest, createResponse, encodeRequest, encodeResponse } from '@hashtree/nostr';
import { WebRTCController } from '../src/p2p/webrtcController.js';

interface ControllerPeer {
  peerId: string;
  dataChannelReady: boolean;
  state: 'connecting' | 'connected' | 'disconnected';
}

interface ControllerPrivateApi {
  peers: Map<string, ControllerPeer>;
  createPeer: (
    peerId: string,
    pubkey: string,
    pool: 'follows' | 'other',
    direction: 'inbound' | 'outbound'
  ) => ControllerPeer;
  onDataChannelMessage: (peerId: string, data: Uint8Array) => Promise<void>;
  forwardRequest: (hash: Uint8Array, targetPeerIds: string[], htl: number) => number;
  sendResponse: (peer: ControllerPeer, hash: Uint8Array, data: Uint8Array) => Promise<void>;
}

function createConnectedController(localStore: Store): {
  controller: WebRTCController;
  peer: ControllerPeer;
  sentDataPayloads: Uint8Array[];
  internal: ControllerPrivateApi;
} {
  const sentDataPayloads: Uint8Array[] = [];
  const controller = new WebRTCController({
    pubkey: 'self-pubkey',
    localStore,
    sendCommand: (cmd) => {
      if (cmd.type === 'rtc:sendData') {
        sentDataPayloads.push(cmd.data);
      }
    },
    sendSignaling: async () => {},
    requestTimeout: 10,
  });

  const internal = controller as unknown as ControllerPrivateApi;
  const peer = internal.createPeer('peer-1', 'peer-pubkey', 'other', 'outbound');
  peer.state = 'connected';
  peer.dataChannelReady = true;

  return { controller, peer, sentDataPayloads, internal };
}

describe('WebRTCController bandwidth stats', () => {
  it('counts full incoming WebRTC wire bytes for requests and responses', async () => {
    const localStore: Store = {
      put: async () => true,
      get: async () => null,
      has: async () => false,
      delete: async () => false,
    };

    const { controller, peer, internal } = createConnectedController(localStore);

    const hash = new Uint8Array(32).fill(7);
    const requestBytes = new Uint8Array(encodeRequest(createRequest(hash, 3)));
    const responsePayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const responseBytes = new Uint8Array(encodeResponse(createResponse(hash, responsePayload)));

    await internal.onDataChannelMessage(peer.peerId, requestBytes);
    await internal.onDataChannelMessage(peer.peerId, responseBytes);

    const [stats] = controller.getPeerStats();
    expect(stats.bytesReceived).toBe(requestBytes.length + responseBytes.length);
  });

  it('counts full outgoing WebRTC wire bytes for requests and responses', async () => {
    const localStore: Store = {
      put: async () => true,
      get: async () => null,
      has: async () => false,
      delete: async () => false,
    };

    const { controller, peer, sentDataPayloads, internal } = createConnectedController(localStore);

    const hash = new Uint8Array(32).fill(9);
    internal.forwardRequest(hash, [peer.peerId], 2);
    await internal.sendResponse(peer, hash, new Uint8Array([10, 11, 12, 13]));

    expect(sentDataPayloads).toHaveLength(2);
    const expectedWireBytes = sentDataPayloads[0]!.length + sentDataPayloads[1]!.length;

    const [stats] = controller.getPeerStats();
    expect(stats.bytesSent).toBe(expectedWireBytes);
  });
});
