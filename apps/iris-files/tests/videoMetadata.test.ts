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
});
