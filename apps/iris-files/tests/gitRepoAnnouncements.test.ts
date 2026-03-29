import { describe, expect, it } from 'vitest';
import {
  countRepoForks,
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

  it('counts the latest personal forks for a repo family', () => {
    const sourceAddress = `30617:${'a'.repeat(64)}:alpha`;
    const earliestUniqueCommit = 'root-commit';

    const count = countRepoForks([
      {
        id: '1'.repeat(64),
        pubkey: 'a'.repeat(64),
        created_at: 5,
        content: '',
        tags: [['d', 'alpha'], ['r', earliestUniqueCommit, 'euc']],
      },
      {
        id: '2'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 10,
        content: '',
        tags: [['d', 'alpha-bob'], ['r', earliestUniqueCommit, 'euc'], ['t', 'personal-fork']],
      },
      {
        id: '3'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 12,
        content: '',
        tags: [['d', 'alpha-bob'], ['r', earliestUniqueCommit, 'euc']],
      },
      {
        id: '4'.repeat(64),
        pubkey: 'c'.repeat(64),
        created_at: 11,
        content: '',
        tags: [['d', 'alpha-carol'], ['r', earliestUniqueCommit, 'euc'], ['t', 'personal-fork']],
      },
      {
        id: '5'.repeat(64),
        pubkey: 'd'.repeat(64),
        created_at: 13,
        content: '',
        tags: [['d', 'other-root'], ['r', 'different-root', 'euc'], ['t', 'personal-fork']],
      },
    ], sourceAddress, earliestUniqueCommit);

    expect(count).toBe(1);
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
