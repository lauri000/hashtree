import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex, type CID } from '@hashtree/core';

const subscribeManyMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
const destroyMock = vi.hoisted(() => vi.fn());
const decodeMock = vi.hoisted(() => vi.fn());

vi.mock('nostr-tools', () => ({
  SimplePool: class {
    subscribeMany(...args: Parameters<typeof subscribeManyMock>) {
      return subscribeManyMock(...args);
    }

    close(...args: Parameters<typeof closeMock>) {
      closeMock(...args);
    }

    destroy(...args: Parameters<typeof destroyMock>) {
      destroyMock(...args);
    }
  },
  nip19: {
    decode: (...args: Parameters<typeof decodeMock>) => decodeMock(...args),
  },
}));

import {
  DEFAULT_ROOT_RESOLVE_TIMEOUT_MS,
  resolveRootPathFromRelays,
} from '../src/capabilities/rootResolver.js';

const NPUB = 'npub1g53mukxnjkcmr94fhryzkqutdz2ukq4ks0gvy5af25rgmwsl4ngq43drvk';
const PUBKEY = '1'.repeat(64);
const ROOT_HASH = '2'.repeat(64);
const EXACT_HASH = '3'.repeat(64);
const CHILD: CID = { hash: Uint8Array.from({ length: 32 }, (_, index) => index + 1) };

function makeEvent(treeName: string, hash: string, createdAt = 1_700_000_000) {
  return {
    id: `${hash}${hash}`.slice(0, 64),
    pubkey: PUBKEY,
    kind: 30078,
    content: '',
    tags: [
      ['d', treeName],
      ['l', 'hashtree'],
      ['hash', hash],
    ],
    created_at: createdAt,
    sig: '4'.repeat(128),
  };
}

describe('rootResolver capability', () => {
  beforeEach(() => {
    subscribeManyMock.mockReset();
    closeMock.mockReset();
    destroyMock.mockReset();
    decodeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an exact tree match without resolving a subpath', async () => {
    decodeMock.mockReturnValue({ type: 'npub', data: PUBKEY });
    subscribeManyMock.mockImplementation((_relays, _filter, params) => {
      params.onevent?.(makeEvent('audio-catalog/root.json', EXACT_HASH));
      return { close: vi.fn() };
    });

    const resolvePath = vi.fn();
    const resolved = await resolveRootPathFromRelays({ resolvePath }, ['wss://relay.example'], NPUB, 'audio-catalog/root.json');

    expect(toHex(resolved!.hash)).toBe(EXACT_HASH);
    expect(resolvePath).not.toHaveBeenCalled();
    expect(subscribeManyMock).toHaveBeenCalledTimes(1);
    expect(subscribeManyMock).toHaveBeenCalledWith(
      ['wss://relay.example', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://relay.snort.social', 'wss://temp.iris.to'],
      {
        kinds: [30078],
        authors: [PUBKEY],
        '#d': ['audio-catalog/root.json'],
        limit: 8,
      },
      expect.objectContaining({ maxWait: DEFAULT_ROOT_RESOLVE_TIMEOUT_MS }),
    );
  });

  it('falls back to the tree root and resolves the remaining subpath', async () => {
    decodeMock.mockReturnValue({ type: 'npub', data: PUBKEY });
    subscribeManyMock
      .mockImplementationOnce((_relays, _filter, params) => {
        params.oneose?.();
        return { close: vi.fn() };
      })
      .mockImplementationOnce((_relays, _filter, params) => {
        params.onevent?.(makeEvent('audio-catalog', ROOT_HASH));
        return { close: vi.fn() };
      });

    const resolvePath = vi.fn().mockResolvedValue({ cid: CHILD });
    const resolved = await resolveRootPathFromRelays(
      { resolvePath },
      ['wss://relay.example'],
      NPUB,
      'audio-catalog/root.json',
      1_234,
    );

    expect(resolved).toEqual(CHILD);
    expect(resolvePath).toHaveBeenCalledTimes(1);
    expect(resolvePath).toHaveBeenCalledWith(
      expect.objectContaining({ hash: expect.any(Uint8Array) }),
      ['root.json'],
    );
    expect(toHex((resolvePath.mock.calls[0]![0] as CID).hash)).toBe(ROOT_HASH);
    expect(subscribeManyMock).toHaveBeenCalledTimes(2);
  });

  it('waits for a newer slower-relay event instead of finishing on the first EOSE', async () => {
    vi.useFakeTimers();
    decodeMock.mockReturnValue({ type: 'npub', data: PUBKEY });
    subscribeManyMock.mockImplementation((_relays, _filter, params) => {
      params.onevent?.(makeEvent('audio-catalog/root.json', '5'.repeat(64), 100));
      params.oneose?.();
      setTimeout(() => {
        params.onevent?.(makeEvent('audio-catalog/root.json', '6'.repeat(64), 200));
      }, 20);
      return { close: vi.fn() };
    });

    const resolvePromise = resolveRootPathFromRelays(
      { resolvePath: vi.fn() },
      ['wss://relay.example'],
      NPUB,
      'audio-catalog/root.json',
      200,
      50,
    );

    await vi.advanceTimersByTimeAsync(100);
    const resolved = await resolvePromise;

    expect(toHex(resolved!.hash)).toBe('6'.repeat(64));
    expect(subscribeManyMock).toHaveBeenCalledTimes(1);
  });
});
