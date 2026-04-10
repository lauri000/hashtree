import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import { fromHex, MemoryStore, type CID } from '@hashtree/core';
import {
  CollectionSource,
  CollectionWriter,
  type CollectionDefinition,
  type CollectionManifest,
  type CollectionManifestIndex,
  type SerializedCid,
} from '../src/index.js';

interface Song {
  id: string;
  title: string;
  artist: string;
  tags: string[];
}

interface CatalogSong {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  album: string;
  albumId: string;
}

interface FixtureCollection {
  by_id_root: SerializedCid | null;
  key_roots: Record<string, SerializedCid | null>;
  search_roots: Record<string, SerializedCid | null>;
  item_count: number;
}

interface RustCollectionFixture {
  blocks: Record<string, string>;
  songs: FixtureCollection;
  catalog: FixtureCollection;
}

function cidFromSeed(seed: number): CID {
  const hash = new Uint8Array(32);
  for (let index = 0; index < hash.length; index += 1) {
    hash[index] = (seed + index) & 0xff;
  }
  return { hash };
}

const songDefinition: CollectionDefinition<Song> = {
  sourceId: 'interop/songs',
  getId: (song) => song.id,
  keyIndexes: [
    {
      name: 'artist',
      keys: (song) => [`artist:${song.artist.toLowerCase()}`],
    },
    {
      name: 'tag',
      keys: (song) => song.tags.map((tag) => `tag:${tag.toLowerCase()}`),
    },
  ],
  searchIndexes: [
    {
      name: 'songs',
      prefix: 's:',
      options: {
        order: 4,
      },
      text: (song) => [song.title, song.artist, ...song.tags],
    },
  ],
};

const catalogDefinition: CollectionDefinition<CatalogSong> = {
  sourceId: 'interop/catalog',
  getId: (song) => song.id,
  searchIndexes: [
    {
      name: 'songs',
      rootName: 'catalog-search',
      prefix: 's:',
      text: (song) => [song.title, song.artist, song.album],
    },
    {
      name: 'artists',
      rootName: 'catalog-search',
      prefix: 'a:',
      entries: (song, context) => [{
        id: song.artistId,
        cid: context.writeContext?.artistCid as CID,
        text: song.artist,
      }],
    },
    {
      name: 'albums',
      rootName: 'catalog-search',
      prefix: 'l:',
      entries: (song, context) => [{
        id: song.albumId,
        cid: context.writeContext?.albumCid as CID,
        text: [song.album, song.artist],
      }],
    },
  ],
};

async function storeFromFixtureBlocks(blocks: Record<string, string>): Promise<MemoryStore> {
  const store = new MemoryStore();
  for (const [hashHex, dataHex] of Object.entries(blocks)) {
    await store.put(fromHex(hashHex), fromHex(dataHex));
  }
  return store;
}

function manifestFromFixture<T>(
  definition: CollectionDefinition<T>,
  fixture: FixtureCollection,
): CollectionManifest {
  const indexes: Record<string, CollectionManifestIndex> = {};

  for (const index of definition.keyIndexes ?? []) {
    indexes[index.name] = {
      kind: 'key',
      root: fixture.key_roots[index.name] ?? null,
    };
  }

  for (const index of definition.searchIndexes ?? []) {
    indexes[index.name] = {
      kind: 'search',
      root: fixture.search_roots[index.name] ?? null,
      prefix: index.prefix ?? `${index.name[0] ?? 's'}:`,
      options: index.options,
    };
  }

  return {
    version: 1,
    sourceId: definition.sourceId,
    schemaVersion: definition.schema?.version ?? definition.schemaVersion ?? 1,
    updatedAt: 0,
    itemCount: fixture.item_count,
    byIdRoot: fixture.by_id_root,
    indexes,
  };
}

describe('Rust collection interop', () => {
  let fixture: RustCollectionFixture;

  beforeAll(() => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const cargoRoot = path.join(repoRoot, 'rust');
    const outDir = mkdtempSync(path.join(tmpdir(), 'htree-collection-interop-'));
    const outFile = path.join(outDir, 'collection-fixture.json');

    execFileSync(
      'cargo',
      ['run', '-q', '-p', 'hashtree-collection', '--bin', 'collection-fixture', '--', outFile],
      { cwd: cargoRoot, stdio: 'inherit' },
    );

    fixture = JSON.parse(readFileSync(outFile, 'utf8')) as RustCollectionFixture;
  }, 120000);

  it('matches rust song roots and loads rust-built indexes in typescript', async () => {
    const store = new MemoryStore();
    const writer = new CollectionWriter(store, songDefinition);
    const original: Song = { id: 'song-a', title: 'Old Horizon', artist: 'Ada', tags: ['night'] };
    const replacement: Song = { id: 'song-a', title: 'New Horizon', artist: 'Bea', tags: ['day'] };
    const other: Song = { id: 'song-b', title: 'Sun Clock', artist: 'Bea', tags: ['ambient'] };

    await writer.put(original, cidFromSeed(12));
    await writer.reindex([
      { item: replacement, cid: cidFromSeed(13) },
      { item: other, cid: cidFromSeed(14) },
    ]);

    const manifest = writer.manifest();
    expect(manifest.byIdRoot).toEqual(fixture.songs.by_id_root);
    expect(manifest.indexes.artist).toEqual({ kind: 'key', root: fixture.songs.key_roots.artist ?? null });
    expect(manifest.indexes.tag).toEqual({ kind: 'key', root: fixture.songs.key_roots.tag ?? null });
    expect(manifest.indexes.songs).toEqual({
      kind: 'search',
      root: fixture.songs.search_roots.songs ?? null,
      prefix: 's:',
      options: {
        order: 4,
      },
    });

    const rustStore = await storeFromFixtureBlocks(fixture.blocks);
    const rustSource = new CollectionSource(rustStore, manifestFromFixture(songDefinition, fixture.songs));

    expect(await rustSource.get('song-a')).toEqual(cidFromSeed(13));
    expect(await rustSource.get('song-b')).toEqual(cidFromSeed(14));
    expect((await rustSource.queryById()).map((result) => result.key)).toEqual(['song-a', 'song-b']);
    expect((await rustSource.queryIndex('artist', { prefix: 'artist:bea' })).map((result) => result.key)).toEqual([
      'artist:bea',
    ]);
    expect((await rustSource.queryIndex('tag', { prefix: 'tag:ambient' })).map((result) => result.key)).toEqual([
      'tag:ambient',
    ]);
    expect(await rustSource.search('songs', 'old')).toEqual([]);
    expect((await rustSource.search('songs', 'new')).map((result) => result.id)).toEqual(['song-a']);
    expect((await rustSource.search('songs', 'sun')).map((result) => result.id)).toEqual(['song-b']);
  });

  it('matches rust shared search roots and derived-entity results', async () => {
    const store = new MemoryStore();
    const writer = new CollectionWriter(store, catalogDefinition);

    await writer.put({
      id: 'song-1',
      title: 'Quiet Bloom',
      artist: 'Open Meridian',
      artistId: 'artist-1',
      album: 'Harbor Echo',
      albumId: 'album-1',
    }, cidFromSeed(50), {
      context: {
        artistCid: cidFromSeed(51),
        albumCid: cidFromSeed(52),
      },
    });

    const manifest = writer.manifest();
    expect(manifest.byIdRoot).toEqual(fixture.catalog.by_id_root);
    expect(manifest.indexes.songs).toEqual({
      kind: 'search',
      root: fixture.catalog.search_roots.songs ?? null,
      prefix: 's:',
      options: undefined,
    });
    expect(manifest.indexes.artists).toEqual({
      kind: 'search',
      root: fixture.catalog.search_roots.artists ?? null,
      prefix: 'a:',
      options: undefined,
    });
    expect(manifest.indexes.albums).toEqual({
      kind: 'search',
      root: fixture.catalog.search_roots.albums ?? null,
      prefix: 'l:',
      options: undefined,
    });
    expect(manifest.indexes.songs.root).toEqual(manifest.indexes.artists.root);
    expect(manifest.indexes.songs.root).toEqual(manifest.indexes.albums.root);

    const rustStore = await storeFromFixtureBlocks(fixture.blocks);
    const rustSource = new CollectionSource(rustStore, manifestFromFixture(catalogDefinition, fixture.catalog));

    expect((await rustSource.search('songs', 'quiet')).map((result) => result.id)).toEqual(['song-1']);
    expect((await rustSource.search('artists', 'open')).map((result) => result.id)).toEqual(['artist-1']);
    expect((await rustSource.search('albums', 'harbor')).map((result) => result.id)).toEqual(['album-1']);
  });
});
