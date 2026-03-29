import { describe, expect, it } from 'vitest';
import {
  parseForkOriginLink,
  parseGitRepoAnnouncement,
} from '../src/lib/gitRepoAnnouncements';

describe('git repo announcement helpers', () => {
  it('parses personal fork announcements and earliest unique commit tags', () => {
    const parsed = parseGitRepoAnnouncement({
      id: 'f'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: 42,
      content: '',
      tags: [
        ['d', 'alpha'],
        ['description', 'Forked repo'],
        ['clone', 'htree://npub1owner/alpha'],
        ['r', '0123456789abcdef', 'euc'],
        ['t', 'personal-fork'],
      ],
    });

    expect(parsed?.repoName).toBe('alpha');
    expect(parsed?.description).toBe('Forked repo');
    expect(parsed?.earliestUniqueCommit).toBe('0123456789abcdef');
    expect(parsed?.isPersonalFork).toBe(true);
    expect(parsed?.address).toBe(`30617:${'a'.repeat(64)}:alpha`);
  });

  it('parses htree fork origin links into local repo hrefs', () => {
    const parsed = parseForkOriginLink('htree://npub1example/repositories/demo');

    expect(parsed).toEqual({
      href: '#/npub1example/repositories/demo',
      label: 'npub1example/repositories/demo',
      npub: 'npub1example',
      repoName: 'repositories/demo',
    });
  });
});
