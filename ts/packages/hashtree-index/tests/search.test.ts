import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '@hashtree/core';
import { SearchIndex } from '../src/search.js';

describe('SearchIndex', () => {
  let store: MemoryStore;
  let index: SearchIndex;

  beforeEach(() => {
    store = new MemoryStore();
    index = new SearchIndex(store, { order: 4 });
  });

  it('keeps whole tokens and splits camelCase variants', () => {
    expect(index.parseKeywords('SirLibre')).toEqual(['sirlibre', 'sir', 'libre']);
    expect(index.parseKeywords('XMLHttpRequest42')).toEqual([
      'xmlhttprequest42',
      'xml',
      'http',
      'request',
    ]);
  });

  it('ranks exact keyword matches ahead of longer prefix matches', async () => {
    let root = null;
    root = await index.index(root, 'p:', ['petrix'], 'pubkey-petrix', '{"name":"petrix"}');
    root = await index.index(root, 'p:', ['petri'], 'pubkey-petri', '{"name":"petri"}');

    const results = await index.search(root, 'p:', 'petri', { limit: 10 });

    expect(results.map((result) => result.id)).toEqual(['pubkey-petri', 'pubkey-petrix']);
  });
});
