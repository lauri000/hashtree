import { MemoryStore, toHex } from '@hashtree/core';
import { nip19 } from 'nostr-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignedEvent } from '../src/iris/protocol';
import { clearMemoryCache, getCachedRootInfo, initTreeRootCache } from '../src/iris/treeRootCache';
import { handleTreeRootEvent, parseTreeRootEvent, setNotifyCallback } from '../src/iris/treeRootSubscription';

function buildEvent(overrides: Partial<SignedEvent>): SignedEvent {
  return {
    id: 'evt1',
    pubkey: 'f'.repeat(64),
    kind: 30078,
    content: '',
    tags: [],
    created_at: 1_700_000_000,
    sig: 'sig',
    ...overrides,
  };
}

beforeEach(() => {
  clearMemoryCache();
  initTreeRootCache(new MemoryStore());
  setNotifyCallback(null as unknown as (npub: string, treeName: string, record: unknown) => void);
});

describe('parseTreeRootEvent', () => {
  it('parses hash and key from tags', () => {
    const hash = 'a'.repeat(64);
    const key = 'b'.repeat(64);
    const event = buildEvent({
      tags: [
        ['d', 'videos/Test Video'],
        ['l', 'hashtree'],
        ['hash', hash],
        ['key', key],
      ],
    });

    const parsed = parseTreeRootEvent(event);
    expect(parsed?.hash).toBe(hash);
    expect(parsed?.key).toBe(key);
    expect(parsed?.visibility).toBe('public');
  });

  it('detects link-visible trees from encrypted tags', () => {
    const hash = 'c'.repeat(64);
    const encryptedKey = 'enc1';
    const keyId = 'kid1';
    const event = buildEvent({
      tags: [
        ['d', 'videos/Test Video'],
        ['l', 'hashtree'],
        ['hash', hash],
        ['encryptedKey', encryptedKey],
        ['keyId', keyId],
      ],
    });

    const parsed = parseTreeRootEvent(event);
    expect(parsed?.hash).toBe(hash);
    expect(parsed?.encryptedKey).toBe(encryptedKey);
    expect(parsed?.keyId).toBe(keyId);
    expect(parsed?.visibility).toBe('link-visible');
  });

  it('falls back to legacy content payloads', () => {
    const hash = 'd'.repeat(64);
    const selfEncryptedKey = 'self-enc';
    const event = buildEvent({
      content: JSON.stringify({
        hash,
        visibility: 'private',
        selfEncryptedKey,
      }),
      tags: [
        ['d', 'videos/Test Video'],
        ['l', 'hashtree'],
      ],
    });

    const parsed = parseTreeRootEvent(event);
    expect(parsed?.hash).toBe(hash);
    expect(parsed?.selfEncryptedKey).toBe(selfEncryptedKey);
    expect(parsed?.visibility).toBe('private');
  });

  it('keeps discovery labels from l tags', () => {
    const hash = 'e'.repeat(64);
    const event = buildEvent({
      tags: [
        ['d', 'repo/test'],
        ['l', 'hashtree'],
        ['l', 'git'],
        ['l', 'git'],
        ['hash', hash],
      ],
    });

    const parsed = parseTreeRootEvent(event);
    expect(parsed?.labels).toEqual(['hashtree', 'git']);
  });
});

describe('handleTreeRootEvent', () => {
  it('keeps the newer cached root when an older replaceable event arrives later', async () => {
    const notify = vi.fn();
    setNotifyCallback(notify);

    const newerHash = '1'.repeat(64);
    const olderHash = '2'.repeat(64);
    const treeName = 'videos/Remember this';
    const pubkey = 'a'.repeat(64);
    const npub = nip19.npubEncode(pubkey);

    await handleTreeRootEvent(buildEvent({
      id: 'newer',
      pubkey,
      created_at: 200,
      tags: [
        ['d', treeName],
        ['l', 'hashtree'],
        ['hash', newerHash],
      ],
    }));

    await handleTreeRootEvent(buildEvent({
      id: 'older',
      pubkey,
      created_at: 100,
      tags: [
        ['d', treeName],
        ['l', 'hashtree'],
        ['hash', olderHash],
      ],
    }));

    const cached = await getCachedRootInfo(
      npub,
      treeName,
    );

    expect(cached).toBeTruthy();
    expect(toHex(cached!.hash)).toBe(newerHash);
    expect(cached!.updatedAt).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(
      npub,
      treeName,
      expect.objectContaining({
        updatedAt: 200,
      }),
    );
  });

  it('keeps the higher-id root when same-second replaceable events arrive out of order', async () => {
    const notify = vi.fn();
    setNotifyCallback(notify);

    const treeName = 'videos/Same second';
    const pubkey = 'b'.repeat(64);
    const npub = nip19.npubEncode(pubkey);
    const highIdHash = '3'.repeat(64);
    const lowIdHash = '4'.repeat(64);
    const createdAt = 300;

    await handleTreeRootEvent(buildEvent({
      id: 'ffff',
      pubkey,
      created_at: createdAt,
      tags: [
        ['d', treeName],
        ['l', 'hashtree'],
        ['hash', highIdHash],
      ],
    }));

    await handleTreeRootEvent(buildEvent({
      id: '0001',
      pubkey,
      created_at: createdAt,
      tags: [
        ['d', treeName],
        ['l', 'hashtree'],
        ['hash', lowIdHash],
      ],
    }));

    const cached = await getCachedRootInfo(npub, treeName);

    expect(cached).toBeTruthy();
    expect(toHex(cached!.hash)).toBe(highIdHash);
    expect(cached!.updatedAt).toBe(createdAt);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
