import { describe, expect, it } from 'vitest';
import { mergePathSources, type PathMergeSource } from '../src/index.js';

describe('mergePathSources', () => {
  it('prefers higher precedence entries on the same path and keeps provenance', () => {
    const result = mergePathSources<string>([
      {
        name: 'owner',
        precedence: 10,
        entries: [{ path: '/docs/readme.md', kind: 'file', value: 'owner' }],
      },
      {
        name: 'writer',
        precedence: 20,
        entries: [{ path: 'docs/readme.md', kind: 'file', value: 'writer' }],
      },
    ]);

    expect(result.entries).toEqual([
      {
        path: 'docs/readme.md',
        kind: 'file',
        value: 'writer',
        source: 'writer',
      },
    ]);
    expect(result.hidden).toEqual([
      {
        path: 'docs/readme.md',
        kind: 'file',
        source: 'owner',
        reason: 'shadowed',
        bySource: 'writer',
      },
    ]);
  });

  it('treats missing paths as no opinion and keeps lower-precedence unique paths', () => {
    const result = mergePathSources<string>([
      {
        name: 'owner',
        precedence: 10,
        entries: [{ path: 'docs/guide.md', kind: 'file', value: 'guide' }],
      },
      {
        name: 'writer',
        precedence: 20,
        entries: [{ path: 'docs/notes.md', kind: 'file', value: 'notes' }],
      },
    ]);

    expect(result.entries).toEqual([
      {
        path: 'docs/guide.md',
        kind: 'file',
        value: 'guide',
        source: 'owner',
      },
      {
        path: 'docs/notes.md',
        kind: 'file',
        value: 'notes',
        source: 'writer',
      },
    ]);
    expect(result.hidden).toEqual([]);
  });

  it('applies explicit tombstones without inferring deletes from absence', () => {
    const result = mergePathSources<string>([
      {
        name: 'owner',
        precedence: 10,
        entries: [{ path: 'docs/guide.md', kind: 'file', value: 'guide' }],
      },
      {
        name: 'writer',
        precedence: 20,
        entries: [],
        tombstones: [{ path: '/docs/guide.md/' }],
      },
    ]);

    expect(result.entries).toEqual([]);
    expect(result.hidden).toEqual([
      {
        path: 'docs/guide.md',
        kind: 'file',
        source: 'owner',
        reason: 'tombstoned',
        bySource: 'writer',
      },
    ]);
  });

  it('treats file-vs-directory collisions as path conflicts resolved by precedence', () => {
    const result = mergePathSources<string>([
      {
        name: 'owner',
        precedence: 10,
        entries: [{ path: 'docs', kind: 'directory', value: 'dir-owner' }],
      },
      {
        name: 'writer',
        precedence: 20,
        entries: [{ path: 'docs', kind: 'file', value: 'file-writer' }],
      },
    ]);

    expect(result.entries).toEqual([
      {
        path: 'docs',
        kind: 'file',
        value: 'file-writer',
        source: 'writer',
      },
    ]);
    expect(result.hidden).toEqual([
      {
        path: 'docs',
        kind: 'directory',
        source: 'owner',
        reason: 'shadowed',
        bySource: 'writer',
      },
    ]);
  });

  it('rejects non-normalizable paths', () => {
    const sources: PathMergeSource<string>[] = [
      {
        name: 'owner',
        entries: [{ path: '../secrets.txt', kind: 'file', value: 'nope' }],
      },
    ];

    expect(() => mergePathSources(sources)).toThrowError('invalid path');
  });
});
