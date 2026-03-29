import { describe, expect, it, vi } from 'vitest';
import type { CID } from '@hashtree/core';

import { readVideoDirectoryMetadata } from '../src/lib/videoMetadata';

function cid(label: string): CID {
  return { hash: new TextEncoder().encode(label), key: undefined } as CID;
}

describe('video metadata reader', () => {
  it('prefers playable entry metadata and still captures thumbnails', async () => {
    const rootCid = cid('root');
    const videoCid = cid('video');
    const thumbCid = cid('thumb');
    const tree = {
      listDirectory: vi.fn(async () => [
        { name: 'thumbnail.webp', cid: thumbCid },
        {
          name: 'video.mp4',
          cid: videoCid,
          meta: { title: 'Meta title', description: 'Meta description', createdAt: 1234 },
        },
      ]),
      resolvePath: vi.fn(async () => null),
      readFile: vi.fn(async () => null),
    };

    await expect(readVideoDirectoryMetadata(tree, rootCid)).resolves.toEqual({
      videoEntry: {
        name: 'video.mp4',
        cid: videoCid,
        meta: { title: 'Meta title', description: 'Meta description', createdAt: 1234 },
      },
      thumbnailEntry: { name: 'thumbnail.webp', cid: thumbCid },
      title: 'Meta title',
      description: 'Meta description',
      createdAt: 1234,
    });
  });

  it('falls back through metadata.json, title.txt, and description.txt when link metadata is missing', async () => {
    const rootCid = cid('root');
    const videoCid = cid('video');
    const metadataCid = cid('metadata');
    const titleCid = cid('title');
    const descriptionCid = cid('description');
    const files = new Map<CID, Uint8Array>([
      [metadataCid, new TextEncoder().encode(JSON.stringify({ createdAt: 456 }))],
      [titleCid, new TextEncoder().encode('Legacy title')],
      [descriptionCid, new TextEncoder().encode('Legacy description')],
    ]);
    const tree = {
      listDirectory: vi.fn(async () => [{ name: 'video.mp4', cid: videoCid }]),
      resolvePath: vi.fn(async (_cid: CID, path: string) => {
        if (path === 'metadata.json') return { cid: metadataCid };
        if (path === 'title.txt') return { cid: titleCid };
        if (path === 'description.txt') return { cid: descriptionCid };
        return null;
      }),
      readFile: vi.fn(async (cidValue: CID) => files.get(cidValue) ?? null),
    };

    await expect(readVideoDirectoryMetadata(tree, rootCid)).resolves.toEqual({
      videoEntry: { name: 'video.mp4', cid: videoCid },
      thumbnailEntry: undefined,
      title: 'Legacy title',
      description: 'Legacy description',
      createdAt: 456,
    });
  });

  it('ignores binary-looking descriptions stored in link metadata and falls back to clean legacy text', async () => {
    const rootCid = cid('root');
    const videoCid = cid('video');
    const descriptionCid = cid('description');
    const files = new Map<CID, Uint8Array>([
      [descriptionCid, new TextEncoder().encode('Recovered description')],
    ]);
    const tree = {
      listDirectory: vi.fn(async () => [
        {
          name: 'video.mp4',
          cid: videoCid,
          meta: {
            title: 'Meta title',
            description: '����\u0010JFIF\u0001\u0001ICC_PROFILEacsp',
            createdAt: 1234,
          },
        },
      ]),
      resolvePath: vi.fn(async (_cid: CID, path: string) => {
        if (path === 'description.txt') return { cid: descriptionCid };
        return null;
      }),
      readFile: vi.fn(async (cidValue: CID) => files.get(cidValue) ?? null),
    };

    await expect(readVideoDirectoryMetadata(tree, rootCid)).resolves.toEqual({
      videoEntry: {
        name: 'video.mp4',
        cid: videoCid,
        meta: {
          title: 'Meta title',
          description: '����\u0010JFIF\u0001\u0001ICC_PROFILEacsp',
          createdAt: 1234,
        },
      },
      thumbnailEntry: undefined,
      title: 'Meta title',
      description: 'Recovered description',
      createdAt: 1234,
    });
  });

  it('drops binary description.txt content instead of rendering garbage', async () => {
    const rootCid = cid('root');
    const videoCid = cid('video');
    const titleCid = cid('title');
    const descriptionCid = cid('description');
    const files = new Map<CID, Uint8Array>([
      [titleCid, new TextEncoder().encode('Legacy title')],
      [descriptionCid, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])],
    ]);
    const tree = {
      listDirectory: vi.fn(async () => [{ name: 'video.mp4', cid: videoCid }]),
      resolvePath: vi.fn(async (_cid: CID, path: string) => {
        if (path === 'title.txt') return { cid: titleCid };
        if (path === 'description.txt') return { cid: descriptionCid };
        return null;
      }),
      readFile: vi.fn(async (cidValue: CID) => files.get(cidValue) ?? null),
    };

    await expect(readVideoDirectoryMetadata(tree, rootCid)).resolves.toEqual({
      videoEntry: { name: 'video.mp4', cid: videoCid },
      thumbnailEntry: undefined,
      title: 'Legacy title',
      description: '',
      createdAt: null,
    });
  });
});
