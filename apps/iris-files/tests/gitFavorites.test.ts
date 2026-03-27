import { describe, expect, it } from 'vitest';
import {
  buildFavoriteRepoHref,
  countFavoriteRepoLikes,
  extractFavoriteRepoAddressFromReaction,
  extractFavoriteRepoRefsFromReactions,
  filterOwnedFavoriteRepos,
  isPositiveFavoriteReaction,
  parseFavoriteRepoAddress,
} from '../src/lib/gitFavorites';

describe('git favorites helpers', () => {
  it('extracts liked repositories from repo reaction events using latest state per repo', () => {
    const refs = extractFavoriteRepoRefsFromReactions([
      {
        pubkey: 'f'.repeat(64),
        created_at: 10,
        content: '+',
        tags: [['k', 'git-repo'], ['i', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha']],
      },
      {
        pubkey: 'f'.repeat(64),
        created_at: 11,
        content: '+',
        tags: [['k', 'git-repo'], ['i', '30617:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:beta/tools']],
      },
      {
        pubkey: 'f'.repeat(64),
        created_at: 12,
        content: '-',
        tags: [['k', 'git-repo'], ['i', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha']],
      },
      {
        pubkey: 'f'.repeat(64),
        created_at: 13,
        content: '+',
        tags: [['k', 'video'], ['i', 'npub1owner/videos/demo']],
      },
    ]);

    expect(refs.map(ref => ref.address)).toEqual([
      '30617:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:beta/tools',
    ]);
  });

  it('builds hrefs for nested repositories', () => {
    const href = buildFavoriteRepoHref('npub1example', 'beta/tools');
    expect(href).toBe('#/npub1example/beta/tools');
  });

  it('parses repo addresses into card data', () => {
    const repo = parseFavoriteRepoAddress('30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha');

    expect(repo?.repoName).toBe('alpha');
    expect(repo?.ownerPubkey).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(repo?.ownerNpub.startsWith('npub1')).toBe(true);
    expect(repo?.href).toContain('/alpha');
  });

  it('detects positive repo reactions and extracts repo identifiers', () => {
    expect(isPositiveFavoriteReaction('+')).toBe(true);
    expect(isPositiveFavoriteReaction('')).toBe(true);
    expect(isPositiveFavoriteReaction('-')).toBe(false);

    expect(extractFavoriteRepoAddressFromReaction([
      ['k', 'git-repo'],
      ['i', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha'],
    ])).toBe('30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha');

    expect(extractFavoriteRepoAddressFromReaction([
      ['k', 'video'],
      ['i', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha'],
    ])).toBeNull();
  });

  it('counts current likes by latest reaction per author', () => {
    const count = countFavoriteRepoLikes([
      {
        pubkey: 'a'.repeat(64),
        created_at: 5,
        content: '+',
        tags: [['k', 'git-repo'], ['i', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha']],
      },
      {
        pubkey: 'b'.repeat(64),
        created_at: 6,
        content: '+',
        tags: [['k', 'git-repo'], ['i', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha']],
      },
      {
        pubkey: 'a'.repeat(64),
        created_at: 7,
        content: '-',
        tags: [['k', 'git-repo'], ['i', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha']],
      },
      {
        pubkey: 'c'.repeat(64),
        created_at: 8,
        content: '+',
        tags: [['k', 'video'], ['i', 'npub1owner/videos/demo']],
      },
    ]);

    expect(count).toBe(1);
  });

  it('filters favorites that duplicate the viewed user’s own repositories', () => {
    const favorites = extractFavoriteRepoRefsFromReactions([
      {
        pubkey: 'f'.repeat(64),
        created_at: 5,
        content: '+',
        tags: [['k', 'git-repo'], ['i', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha']],
      },
      {
        pubkey: 'f'.repeat(64),
        created_at: 6,
        content: '+',
        tags: [['k', 'git-repo'], ['i', '30617:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:beta']],
      },
    ]);
    const owner = parseFavoriteRepoAddress('30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha');

    const filtered = filterOwnedFavoriteRepos(
      owner!.ownerNpub,
      ['alpha'],
      favorites,
    );

    expect(filtered.map(repo => repo.repoName)).toEqual(['beta']);
  });
});
