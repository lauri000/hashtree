import { describe, it, expect } from 'vitest';
import type { SignedEvent } from '../src/worker/protocol';
import { parseTreeRootEvent } from '../src/worker/treeRootSubscription';

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
});
