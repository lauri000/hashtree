import { describe, expect, it } from 'vitest';
import {
  buildFavoriteRepoHref,
  extractFavoriteRepoRefs,
  filterOwnedFavoriteRepos,
  parseFavoriteRepoAddress,
} from '../src/lib/gitFavorites';

describe('git favorites helpers', () => {
  it('extracts repo references from bookmark tags and preserves list order', () => {
    const refs = extractFavoriteRepoRefs([
      ['title', 'Bookmarks'],
      ['a', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha'],
      ['e', 'note-id'],
      ['a', '30023:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:article'],
      ['a', '30617:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:beta/tools'],
      ['a', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha'],
    ]);

    expect(refs.map(ref => ref.address)).toEqual([
      '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha',
      '30617:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:beta/tools',
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

  it('filters favorites that duplicate the viewed user’s own repositories', () => {
    const favorites = extractFavoriteRepoRefs([
      ['a', '30617:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:alpha'],
      ['a', '30617:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:beta'],
    ]);

    const filtered = filterOwnedFavoriteRepos(
      favorites[0].ownerNpub,
      ['alpha'],
      favorites,
    );

    expect(filtered.map(repo => repo.repoName)).toEqual(['beta']);
  });
});
