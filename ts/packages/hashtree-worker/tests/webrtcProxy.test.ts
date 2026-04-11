import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebRTCProxy } from '../src/p2p/webrtcProxy.js';

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: ((this: RTCDataChannel, ev: Event) => any) | null = null;
  onclose: ((this: RTCDataChannel, ev: Event) => any) | null = null;
  onerror: ((this: RTCDataChannel, ev: Event) => any) | null = null;
  onmessage: ((this: RTCDataChannel, ev: MessageEvent) => any) | null = null;
  onbufferedamountlow: ((this: RTCDataChannel, ev: Event) => any) | null = null;
  readonly sent: Uint8Array[] = [];

  send(data: ArrayBufferLike): void {
    this.sent.push(new Uint8Array(data.slice(0)));
  }

  close(): void {}
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];

  connectionState: RTCPeerConnectionState = 'connected';
  onicecandidate: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => any) | null = null;
  ondatachannel: ((this: RTCPeerConnection, ev: RTCDataChannelEvent) => any) | null = null;
  onconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null = null;
  readonly dataChannel = new FakeDataChannel();

  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel {
    return this.dataChannel as unknown as RTCDataChannel;
  }

  close(): void {}
}

afterEach(() => {
  FakeRTCPeerConnection.instances = [];
  vi.unstubAllGlobals();
});

describe('WebRTCProxy', () => {
  it('prioritizes request frames ahead of queued response traffic', () => {
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection as unknown as typeof RTCPeerConnection);

    const proxy = new WebRTCProxy(() => undefined);
    proxy.handleCommand({ type: 'rtc:createPeer', peerId: 'peer-1', pubkey: 'pubkey-1' });

    const connection = FakeRTCPeerConnection.instances[0];
    expect(connection).toBeDefined();

    const channel = connection.dataChannel;
    channel.bufferedAmount = 300_000;

    proxy.handleCommand({ type: 'rtc:sendData', peerId: 'peer-1', data: new Uint8Array([0x01, 0xaa]) });
    proxy.handleCommand({ type: 'rtc:sendData', peerId: 'peer-1', data: new Uint8Array([0x00, 0xbb]) });

    expect(channel.sent).toHaveLength(0);

    channel.bufferedAmount = 0;
    channel.onbufferedamountlow?.call(channel as unknown as RTCDataChannel, new Event('bufferedamountlow'));

    expect(channel.sent.map((frame) => frame[0])).toEqual([0x00, 0x01]);
  });
});
