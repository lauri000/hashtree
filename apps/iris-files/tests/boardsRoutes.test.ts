import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { matchBoardsRoute } from '../src/components/Boards/routes';

const npub = nip19.npubEncode('b'.repeat(64));

describe('matchBoardsRoute', () => {
  it('routes /:npub/profile to the profile view before treating profile as a board name', () => {
    const matched = matchBoardsRoute(`/${npub}/profile`);

    expect(matched.key).toBe('profile');
    expect(matched.params.npub).toBe(npub);
  });

  it('still routes encoded board tree names to the board view', () => {
    const matched = matchBoardsRoute(`/${npub}/${encodeURIComponent('boards/roadmap')}`);

    expect(matched.key).toBe('board');
    expect(matched.params.npub).toBe(npub);
    expect(matched.params.treeName).toBe('boards/roadmap');
  });
});
