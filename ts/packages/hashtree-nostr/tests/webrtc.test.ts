import { describe, it, expect, beforeEach } from 'vitest';
import {
  decrementHTL,
  decrementHTLWithPolicy,
  shouldForward,
  shouldForwardHTL,
  generatePeerHTLConfig,
} from '../src/webrtc/protocol.js';
import {
  MAX_HTL,
  BLOB_REQUEST_POLICY,
  MESH_EVENT_POLICY,
  HtlMode,
  WEBRTC_KIND,
  MESH_MAX_HTL,
  MESH_PROTOCOL,
  MESH_PROTOCOL_VERSION,
  createMeshNostrEventFrame,
  validateMeshNostrFrame,
} from '../src/webrtc/types.js';
import { WebRTCStore } from '../src/webrtc/store.js';
import { MemoryStore, sha256, toHex, fromHex } from '@hashtree/core';

/**
 * Unit tests for WebRTC data protocol
 * Tests the request/response protocol without actual WebRTC connections
 */

describe('WebRTC Data Protocol', () => {
  describe('Data Request/Response', () => {
    it('should format request messages correctly', () => {
      const requestId = 1;
      const hash = '0'.repeat(64);
      const msg = { type: 'req', id: requestId, hash };

      expect(msg.type).toBe('req');
      expect(msg.id).toBe(1);
      expect(msg.hash).toBe(hash);
    });

    it('should format response messages correctly', () => {
      const msg = { type: 'res', id: 1, hash: '0'.repeat(64), found: true };

      expect(msg.type).toBe('res');
      expect(msg.found).toBe(true);
    });

    it('should format binary data with request ID prefix', () => {
      const requestId = 42;
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      // Format: [4 bytes requestId (little endian)][data]
      const packet = new Uint8Array(4 + data.length);
      const view = new DataView(packet.buffer);
      view.setUint32(0, requestId, true);
      packet.set(data, 4);

      // Verify
      const parsedId = new DataView(packet.buffer).getUint32(0, true);
      const parsedData = packet.slice(4);

      expect(parsedId).toBe(42);
      expect(parsedData).toEqual(data);
    });
  });

  describe('Hash Verification', () => {
    it('should verify data matches hash', async () => {
      const data = new TextEncoder().encode('Hello, WebRTC!');
      const hash = await sha256(data);
      const hashHex = toHex(hash);

      // Simulate receiving data and verifying
      const computedHash = await sha256(data);
      expect(toHex(computedHash)).toBe(hashHex);
    });

    it('should reject data with mismatched hash', async () => {
      const data = new TextEncoder().encode('Hello, WebRTC!');
      const hash = await sha256(data);
      const hashHex = toHex(hash);

      // Tampered data
      const tamperedData = new TextEncoder().encode('Hello, WebRTC?');
      const computedHash = await sha256(tamperedData);

      expect(toHex(computedHash)).not.toBe(hashHex);
    });
  });

  describe('Store Integration', () => {
    let store: MemoryStore;

    beforeEach(() => {
      store = new MemoryStore();
    });

    it('should store and retrieve data by hash', async () => {
      const content = 'Test file content';
      const data = new TextEncoder().encode(content);
      const hash = await sha256(data);

      await store.put(hash, data);

      const retrieved = await store.get(hash);
      expect(retrieved).not.toBeNull();
      expect(new TextDecoder().decode(retrieved!)).toBe(content);
    });

    it('should return null for missing hash', async () => {
      const missingHash = fromHex('0'.repeat(64));
      const result = await store.get(missingHash);
      expect(result).toBeNull();
    });
  });
});

describe('PeerId', () => {
  it('should generate unique UUIDs', async () => {
    const { generateUuid } = await import('../src/webrtc/types.js');

    const uuid1 = generateUuid();
    const uuid2 = generateUuid();

    expect(uuid1).not.toBe(uuid2);
    expect(uuid1.length).toBeGreaterThan(10);
  });

  it('should format peerId as pubkey', async () => {
    const { PeerId } = await import('../src/webrtc/types.js');

    const pubkey = 'a'.repeat(64);
    const peerId = new PeerId(pubkey);

    expect(peerId.toString()).toBe(pubkey);
    expect(peerId.pubkey).toBe(pubkey);
  });

  it('should generate short form for display', async () => {
    const { PeerId } = await import('../src/webrtc/types.js');

    const pubkey = 'abcdef1234567890'.repeat(4);
    const peerId = new PeerId(pubkey);

    const short = peerId.short();
    expect(short).toBe('abcdef12');
  });

  it('should parse peerId from string', async () => {
    const { PeerId } = await import('../src/webrtc/types.js');

    const str = 'a'.repeat(64);
    const peerId = PeerId.fromString(str);

    expect(peerId.pubkey).toBe('a'.repeat(64));
    expect(peerId.toString()).toBe('a'.repeat(64));
  });

  it('should reject legacy session-suffixed peerId strings', async () => {
    const { PeerId } = await import('../src/webrtc/types.js');
    expect(() => PeerId.fromString('a'.repeat(64) + ':legacy')).toThrow('Invalid peer string');
  });
});

describe('HTL (Hops To Live)', () => {
  describe('shared HTL policies', () => {
    it('blob policy matches legacy defaults', () => {
      expect(BLOB_REQUEST_POLICY.mode).toBe(HtlMode.Probabilistic);
      expect(BLOB_REQUEST_POLICY.maxHtl).toBe(MAX_HTL);
      expect(BLOB_REQUEST_POLICY.pAtMax).toBe(0.5);
      expect(BLOB_REQUEST_POLICY.pAtMin).toBe(0.25);
    });

    it('mesh policy is probabilistic and tighter', () => {
      expect(MESH_EVENT_POLICY.mode).toBe(HtlMode.Probabilistic);
      expect(MESH_EVENT_POLICY.maxHtl).toBe(4);
      expect(MESH_EVENT_POLICY.maxHtl).toBeLessThan(BLOB_REQUEST_POLICY.maxHtl);
      expect(MESH_EVENT_POLICY.pAtMax).toBeGreaterThan(BLOB_REQUEST_POLICY.pAtMax);
      expect(MESH_EVENT_POLICY.pAtMin).toBeGreaterThan(BLOB_REQUEST_POLICY.pAtMin);
    });

    it('decrementHTLWithPolicy respects fixed per-peer samples', () => {
      const cfg = { atMaxSample: 0.6, atMinSample: 0.4 };
      expect(decrementHTLWithPolicy(BLOB_REQUEST_POLICY.maxHtl, BLOB_REQUEST_POLICY, cfg))
        .toBe(BLOB_REQUEST_POLICY.maxHtl);
      expect(decrementHTLWithPolicy(MESH_EVENT_POLICY.maxHtl, MESH_EVENT_POLICY, cfg))
        .toBe(MESH_EVENT_POLICY.maxHtl - 1);
      expect(decrementHTLWithPolicy(1, MESH_EVENT_POLICY, cfg)).toBe(0);
      expect(shouldForwardHTL(0)).toBe(false);
      expect(shouldForwardHTL(1)).toBe(true);
    });

    it('formal: decrement policy is monotonic and follows edge rules', () => {
      const samplePoints = [0.0, 0.2, 0.49, 0.5, 0.75, 0.99];
      for (const policy of [BLOB_REQUEST_POLICY, MESH_EVENT_POLICY]) {
        for (let htl = 0; htl <= policy.maxHtl + 4; htl++) {
          const bounded = Math.min(htl, policy.maxHtl);
          for (const atMaxSample of samplePoints) {
            for (const atMinSample of samplePoints) {
              const cfg = { atMaxSample, atMinSample };
              const next = decrementHTLWithPolicy(htl, policy, cfg);
              expect(next).toBeLessThanOrEqual(bounded);

              if (bounded === 0) {
                expect(next).toBe(0);
                continue;
              }

              if (bounded === policy.maxHtl) {
                const expected = atMaxSample < policy.pAtMax ? bounded - 1 : bounded;
                expect(next).toBe(expected);
                continue;
              }

              if (bounded === 1) {
                const expected = atMinSample < policy.pAtMin ? 0 : 1;
                expect(next).toBe(expected);
                continue;
              }

              expect(next).toBe(bounded - 1);
            }
          }
        }
      }
    });

    it('formal: shouldForwardHTL is equivalent to htl > 0', () => {
      for (let htl = -32; htl <= 512; htl++) {
        expect(shouldForwardHTL(htl)).toBe(htl > 0);
      }
    });
  });

  describe('mesh frame validation', () => {
    it('accepts signed kind 25050 event', () => {
      const event = {
        id: '1'.repeat(64),
        pubkey: '2'.repeat(64),
        sig: '3'.repeat(128),
        kind: WEBRTC_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['l', 'hello']],
        content: '',
      };

      const frame = createMeshNostrEventFrame(
        event as any,
        'peer-a',
        MESH_EVENT_POLICY.maxHtl,
      );
      expect(validateMeshNostrFrame(frame)).toBeNull();
      expect(frame.frame_id.length).toBeGreaterThan(0);
      expect(frame.sender_peer_id).toBe('peer-a');
    });

    it('rejects non-webrtc event kind', () => {
      const event = {
        id: '4'.repeat(64),
        pubkey: '5'.repeat(64),
        sig: '6'.repeat(128),
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'nope',
      };
      const frame = createMeshNostrEventFrame(
        event as any,
        'peer-a',
        MESH_EVENT_POLICY.maxHtl,
      );
      expect(validateMeshNostrFrame(frame)).toBe('unsupported event kind');
    });

    it('formal: rejects invalid protocol, version, and htl bounds', () => {
      const event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        sig: 'c'.repeat(128),
        kind: WEBRTC_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['l', 'hello']],
        content: '',
      };
      const frame = createMeshNostrEventFrame(event as any, 'peer-a', MESH_EVENT_POLICY.maxHtl);

      expect(validateMeshNostrFrame(frame)).toBeNull();

      frame.protocol = 'invalid';
      expect(validateMeshNostrFrame(frame)).toBe('invalid protocol');
      frame.protocol = MESH_PROTOCOL;

      frame.version = MESH_PROTOCOL_VERSION + 1;
      expect(validateMeshNostrFrame(frame)).toBe('invalid version');
      frame.version = MESH_PROTOCOL_VERSION;

      frame.htl = 0;
      expect(validateMeshNostrFrame(frame)).toBe('invalid htl');
      frame.htl = MESH_MAX_HTL + 1;
      expect(validateMeshNostrFrame(frame)).toBe('invalid htl');
    });

    it('formal: rejects empty frame and sender identifiers', () => {
      const event = {
        id: 'd'.repeat(64),
        pubkey: 'e'.repeat(64),
        sig: 'f'.repeat(128),
        kind: WEBRTC_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['l', 'hello']],
        content: '',
      };
      const frame = createMeshNostrEventFrame(event as any, 'peer-a', MESH_EVENT_POLICY.maxHtl);

      frame.frame_id = '';
      expect(validateMeshNostrFrame(frame)).toBe('missing frame id');

      frame.frame_id = 'frame-1';
      frame.sender_peer_id = 'peer-a:legacy';
      expect(validateMeshNostrFrame(frame)).toBe('invalid sender peer id');

      frame.sender_peer_id = 'peer-a';
      frame.sender_peer_id = '';
      expect(validateMeshNostrFrame(frame)).toBe('missing sender peer id');
    });
  });

  describe('decrementHTL', () => {
    it('should always decrement at middle values regardless of config', () => {
      const configNever = { atMaxSample: 0.99, atMinSample: 0.99 };
      const configAlways = { atMaxSample: 0.01, atMinSample: 0.01 };

      // Middle values (2 to MAX_HTL-1) always decrement
      expect(decrementHTL(5, configNever)).toBe(4);
      expect(decrementHTL(5, configAlways)).toBe(4);
      expect(decrementHTL(2, configNever)).toBe(1);
      expect(decrementHTL(2, configAlways)).toBe(1);
    });

    it('should respect config.decrementAtMax at MAX_HTL', () => {
      expect(decrementHTL(MAX_HTL, { atMaxSample: 0.1, atMinSample: 0.9 })).toBe(MAX_HTL - 1);
      expect(decrementHTL(MAX_HTL, { atMaxSample: 0.9, atMinSample: 0.9 })).toBe(MAX_HTL);
    });

    it('should respect config.decrementAtMin at HTL=1', () => {
      expect(decrementHTL(1, { atMaxSample: 0.9, atMinSample: 0.1 })).toBe(0);
      expect(decrementHTL(1, { atMaxSample: 0.9, atMinSample: 0.9 })).toBe(1);
    });

    it('should return 0 when HTL is already 0 or negative', () => {
      const config = { atMaxSample: 0.1, atMinSample: 0.1 };
      expect(decrementHTL(0, config)).toBe(0);
      expect(decrementHTL(-1, config)).toBe(0);
    });
  });

  describe('shouldForward', () => {
    it('should return true when HTL > 0', () => {
      expect(shouldForward(MAX_HTL)).toBe(true);
      expect(shouldForward(5)).toBe(true);
      expect(shouldForward(1)).toBe(true);
    });

    it('should return false when HTL <= 0', () => {
      expect(shouldForward(0)).toBe(false);
      expect(shouldForward(-1)).toBe(false);
    });
  });

  describe('generatePeerHTLConfig', () => {
    it('should produce valid sampled config', () => {
      const config = generatePeerHTLConfig();
      expect(config.atMaxSample).toBeGreaterThanOrEqual(0);
      expect(config.atMaxSample).toBeLessThan(1);
      expect(config.atMinSample).toBeGreaterThanOrEqual(0);
      expect(config.atMinSample).toBeLessThan(1);
    });

    it('should produce varied configs over many generations', () => {
      // Generate many configs and check we get some variation
      let maxLtHalf = 0;
      let maxGeHalf = 0;
      let minLtHalf = 0;
      let minGeHalf = 0;

      for (let i = 0; i < 100; i++) {
        const config = generatePeerHTLConfig();
        if (config.atMaxSample < 0.5) maxLtHalf++;
        else maxGeHalf++;
        if (config.atMinSample < 0.5) minLtHalf++;
        else minGeHalf++;
      }

      expect(maxLtHalf).toBeGreaterThan(0);
      expect(maxGeHalf).toBeGreaterThan(0);
      expect(minLtHalf).toBeGreaterThan(0);
      expect(minGeHalf).toBeGreaterThan(0);
    });
  });

  describe('mesh forwarding dedupe invariants', () => {
    function createStoreForFormalTests(): any {
      const testSigner = async (evt: {
        kind: number;
        created_at: number;
        tags: string[][];
        content: string;
      }) => ({
        id: '1'.repeat(64),
        pubkey: '2'.repeat(64),
        sig: '3'.repeat(128),
        kind: evt.kind,
        created_at: evt.created_at,
        tags: evt.tags,
        content: evt.content,
      });

      return new WebRTCStore({
        signer: testSigner,
        pubkey: '2'.repeat(64),
        encrypt: async () => '',
        decrypt: async () => '',
        giftWrap: async (inner: { kind: number; content: string; tags: string[][] }) => testSigner({
          kind: WEBRTC_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify(inner),
        }),
        giftUnwrap: async () => null,
        relays: [],
      }) as any;
    }

    function makeTestMeshFrame(htl: number) {
      return createMeshNostrEventFrame({
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        sig: 'c'.repeat(128),
        kind: WEBRTC_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['l', 'hello']],
        content: '',
      } as any, 'peer-origin', htl);
    }

    it('formal: frame/event seen sets reject duplicates', () => {
      const store = createStoreForFormalTests();
      expect(store.markSeenFrameId('frame-1')).toBe(true);
      expect(store.markSeenFrameId('frame-1')).toBe(false);
      expect(store.markSeenEventId('event-1')).toBe(true);
      expect(store.markSeenEventId('event-1')).toBe(false);
    });

    it('formal: seen-set pruning honors deterministic cap eviction', () => {
      const store = createStoreForFormalTests();
      const now = Date.now();
      const seen = new Map<string, number>([
        ['a', now],
        ['b', now],
        ['c', now],
      ]);

      store.pruneSeenSet(seen, 60_000, 2);
      expect(seen.size).toBe(2);
      expect(seen.has('a')).toBe(false);
      expect(seen.has('b')).toBe(true);
      expect(seen.has('c')).toBe(true);
    });

    it('formal: forwarding excludes sender peer', () => {
      const store = createStoreForFormalTests();
      const sent: Array<{ peerId: string; htl: number }> = [];
      const mkPeer = (peerId: string) => ({
        peerId,
        isConnected: true,
        getHTLConfig: () => ({ atMaxSample: 0.0, atMinSample: 0.0 }),
        sendMeshFrameText: (frame: { htl: number }) => {
          sent.push({ peerId, htl: frame.htl });
          return true;
        },
      });

      store.peers = new Map([
        ['a', { pool: 'other', peer: mkPeer('peer-a') }],
        ['b', { pool: 'other', peer: mkPeer('peer-b') }],
        ['c', { pool: 'other', peer: mkPeer('peer-c') }],
      ]);

      const forwarded = store.forwardMeshFrame(makeTestMeshFrame(MESH_EVENT_POLICY.maxHtl), 'peer-b');
      expect(forwarded).toBe(2);
      expect(sent.map((x) => x.peerId).sort()).toEqual(['peer-a', 'peer-c']);
      expect(sent.every((x) => x.htl > 0)).toBe(true);
    });

    it('formal: forwarding stops when HTL is exhausted', () => {
      const store = createStoreForFormalTests();
      const mkPeer = (peerId: string) => ({
        peerId,
        isConnected: true,
        getHTLConfig: () => ({ atMaxSample: 0.0, atMinSample: 0.0 }),
        sendMeshFrameText: () => true,
      });

      store.peers = new Map([
        ['a', { pool: 'other', peer: mkPeer('peer-a') }],
        ['b', { pool: 'other', peer: mkPeer('peer-b') }],
      ]);

      const forwarded = store.forwardMeshFrame(makeTestMeshFrame(1));
      expect(forwarded).toBe(0);
    });
  });
});
