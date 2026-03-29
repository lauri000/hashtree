import { describe, expect, it } from 'vitest';
import {
  getUserSearchTerms,
  parseStoredUserIndexEntry,
  serializeStoredUserIndexEntry,
} from '../src/lib/search/userIndexEntry';

describe('user search index entry helpers', () => {
  it('indexes npub terms without indexing the hex pubkey itself', () => {
    const pubkey = 'f'.repeat(64);
    const terms = getUserSearchTerms({
      pubkey,
      name: 'Alice Example',
      displayName: 'Alice',
      nip05: 'alice@example.com',
    });

    expect(terms.some(term => term.startsWith('npub1'))).toBe(true);
    expect(terms).not.toContain(pubkey);
    expect(terms).toContain('alice');
  });

  it('serializes stored entries without duplicating npub', () => {
    const serialized = serializeStoredUserIndexEntry({
      pubkey: 'f'.repeat(64),
      name: 'Alice Example',
      displayName: 'Alice',
      nip05: 'alice@example.com',
    });

    expect(serialized).toContain('"pubkey"');
    expect(serialized).not.toContain('"npub"');
  });

  it('hydrates npub from a stored pubkey-only entry', () => {
    const entry = parseStoredUserIndexEntry(JSON.stringify({
      pubkey: 'f'.repeat(64),
      name: 'Alice Example',
    }));

    expect(entry).toMatchObject({
      pubkey: 'f'.repeat(64),
      name: 'Alice Example',
    });
    expect(entry?.npub.startsWith('npub1')).toBe(true);
  });

  it('accepts legacy stored entries that still include npub', () => {
    const entry = parseStoredUserIndexEntry(JSON.stringify({
      pubkey: 'f'.repeat(64),
      npub: 'npub1lllllllllllllllllllllllllllllllllllllllllllllllllllsq7lrjw',
      displayName: 'Alice',
    }));

    expect(entry).toMatchObject({
      pubkey: 'f'.repeat(64),
      npub: 'npub1lllllllllllllllllllllllllllllllllllllllllllllllllllsq7lrjw',
      displayName: 'Alice',
    });
  });
});
