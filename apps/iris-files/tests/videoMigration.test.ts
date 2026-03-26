import { describe, expect, it, vi } from 'vitest';
import { LinkType, nhashEncode, toHex, type CID } from '@hashtree/core';

vi.mock('../src/refResolver', () => ({
  getRefResolver: () => ({}),
}));

vi.mock('../src/store', () => ({
  getTree: vi.fn(),
}));

vi.mock('../src/lib/workerInit', () => ({
  getWorkerAdapter: vi.fn(),
  waitForRelayConnection: vi.fn(),
  waitForWorkerAdapter: vi.fn(),
}));

vi.mock('../src/stores/trees', () => ({
  getLinkKey: vi.fn(),
  recoverLinkKeyFromSelfEncrypted: vi.fn(),
  storeLinkKey: vi.fn(),
  waitForLinkKeysCache: vi.fn(),
}));

vi.mock('../src/stores/treeRoot', () => ({
  getTreeRootSync: vi.fn(),
  waitForTreeRoot: vi.fn(),
}));

vi.mock('../src/lib/readableVideoRoot', () => ({
  resolveReadableThumbnailRoot: vi.fn(),
  resolveReadableVideoRoot: vi.fn(),
}));

vi.mock('../src/nostr', () => ({
  nostrStore: {
    getState: () => ({}),
  },
  saveHashtree: vi.fn(),
}));

import { analyzeVideoDirectoryRepair } from '../src/lib/videoMigration';

function makeCid(seed: number): CID {
  return {
    hash: Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256),
  };
}

function cidKey(cid: CID): string {
  return `${toHex(cid.hash)}:${cid.key ? toHex(cid.key) : ''}`;
}

type Entry = {
  name: string;
  cid: CID;
  size: number;
  type: LinkType;
  meta?: Record<string, unknown>;
};

function createTreeFixture() {
  const directories = new Map<string, Entry[]>();
  const files = new Map<string, Uint8Array>();

  return {
    tree: {
      listDirectory: vi.fn(async (cid: CID) => directories.get(cidKey(cid)) ?? null),
      readFile: vi.fn(async (cid: CID) => files.get(cidKey(cid)) ?? null),
      setEntry: vi.fn(),
    },
    directories,
    files,
  };
}

describe('analyzeVideoDirectoryRepair', () => {
  it('promotes legacy single-video metadata into the video entry', async () => {
    const ROOT = makeCid(1);
    const VIDEO = makeCid(10);
    const META = makeCid(20);
    const THUMB = makeCid(30);
    const { tree, directories, files } = createTreeFixture();

    directories.set(cidKey(ROOT), [
      { name: 'video.mp4', cid: VIDEO, size: 123, type: LinkType.File, meta: { createdAt: 100 } },
      { name: 'metadata.json', cid: META, size: 64, type: LinkType.File },
      { name: 'thumbnail.jpg', cid: THUMB, size: 64, type: LinkType.File },
    ]);
    files.set(cidKey(META), new TextEncoder().encode(JSON.stringify({
      title: 'Legacy Title',
      description: 'Legacy description',
      duration: 321,
      thumbnail: 'thumbnail.jpg',
      createdAt: 111,
    })));

    const analysis = await analyzeVideoDirectoryRepair(tree as never, {
      treeName: 'videos/Test Clip',
      baseRootCid: ROOT,
      fallbackCreatedAt: 222,
    });

    expect(analysis.kind).toBe('single');
    expect(analysis.plan?.kind).toBe('single');
    expect(analysis.plan && analysis.plan.kind === 'single' ? analysis.plan.nextVideoMeta : null).toMatchObject({
      createdAt: 100,
      title: 'Legacy Title',
      description: 'Legacy description',
      duration: 321,
      thumbnail: nhashEncode(THUMB),
    });
    expect(analysis.issueCodes).toEqual(expect.arrayContaining(['legacy-metadata', 'missing-title', 'missing-thumbnail']));
  });

  it('repairs a single-video root with a thumbnail recovered from a historical donor root', async () => {
    const ROOT = makeCid(40);
    const DONOR = makeCid(41);
    const VIDEO = makeCid(42);
    const DONOR_THUMB = makeCid(43);
    const { tree, directories } = createTreeFixture();

    directories.set(cidKey(ROOT), [
      { name: 'video.mp4', cid: VIDEO, size: 123, type: LinkType.File, meta: { title: 'No Thumb Yet' } },
    ]);
    directories.set(cidKey(DONOR), [
      { name: 'video.mp4', cid: VIDEO, size: 123, type: LinkType.File, meta: { title: 'No Thumb Yet' } },
      { name: 'thumbnail.png', cid: DONOR_THUMB, size: 64, type: LinkType.File },
    ]);

    const analysis = await analyzeVideoDirectoryRepair(tree as never, {
      treeName: 'videos/Recovered Thumb',
      baseRootCid: ROOT,
      thumbnailDonorRootCid: DONOR,
      fallbackCreatedAt: 333,
    });

    expect(analysis.plan?.kind).toBe('single');
    if (!analysis.plan || analysis.plan.kind !== 'single') {
      throw new Error('expected single repair plan');
    }
    expect(analysis.plan.thumbnailEntryToEnsure?.name).toBe('thumbnail.png');
    expect(analysis.plan.nextVideoMeta.thumbnail).toBe(nhashEncode(DONOR_THUMB));
    expect(analysis.issueCodes).toEqual(expect.arrayContaining(['missing-thumbnail', 'historical-thumbnail']));
  });

  it('promotes playlist child metadata into both the parent directory entry and the child video entry', async () => {
    const ROOT = makeCid(60);
    const CHILD = makeCid(61);
    const VIDEO = makeCid(62);
    const INFO = makeCid(63);
    const THUMB = makeCid(64);
    const { tree, directories, files } = createTreeFixture();

    directories.set(cidKey(ROOT), [
      { name: 'track-a', cid: CHILD, size: 50, type: LinkType.Dir },
    ]);
    directories.set(cidKey(CHILD), [
      { name: 'video.mp4', cid: VIDEO, size: 123, type: LinkType.File, meta: {} },
      { name: 'info.json', cid: INFO, size: 128, type: LinkType.File },
      { name: 'thumbnail.webp', cid: THUMB, size: 64, type: LinkType.File },
    ]);
    files.set(cidKey(INFO), new TextEncoder().encode(JSON.stringify({
      title: 'Track A',
      description: 'Recovered from info.json',
      duration: 222,
    })));

    const analysis = await analyzeVideoDirectoryRepair(tree as never, {
      treeName: 'videos/Music',
      baseRootCid: ROOT,
      fallbackCreatedAt: 444,
    });

    expect(analysis.kind).toBe('playlist');
    expect(analysis.plan?.kind).toBe('playlist');
    if (!analysis.plan || analysis.plan.kind !== 'playlist') {
      throw new Error('expected playlist repair plan');
    }
    expect(analysis.plan.childPlans).toHaveLength(1);
    expect(analysis.plan.childPlans[0].nextParentMeta).toMatchObject({
      title: 'Track A',
      description: 'Recovered from info.json',
      duration: 222,
      thumbnail: nhashEncode(THUMB),
    });
    expect(analysis.plan.childPlans[0].nextVideoMeta).toMatchObject({
      title: 'Track A',
      description: 'Recovered from info.json',
      duration: 222,
      thumbnail: nhashEncode(THUMB),
    });
    expect(analysis.issueCodes).toEqual(expect.arrayContaining(['playlist-metadata', 'legacy-metadata', 'missing-title']));
  });

  it('returns a no-op analysis for already-normalized single-video roots', async () => {
    const ROOT = makeCid(80);
    const VIDEO = makeCid(81);
    const THUMB = makeCid(82);
    const { tree, directories } = createTreeFixture();

    directories.set(cidKey(ROOT), [
      {
        name: 'video.mp4',
        cid: VIDEO,
        size: 123,
        type: LinkType.File,
        meta: {
          title: 'Ready',
          createdAt: 10,
          thumbnail: nhashEncode(THUMB),
        },
      },
      { name: 'thumbnail.jpg', cid: THUMB, size: 64, type: LinkType.File },
    ]);

    const analysis = await analyzeVideoDirectoryRepair(tree as never, {
      treeName: 'videos/Ready',
      baseRootCid: ROOT,
      fallbackCreatedAt: 555,
    });

    expect(analysis.plan).toBeNull();
    expect(analysis.issueCodes).toEqual([]);
    expect(analysis.unresolvedIssueCodes).toEqual([]);
  });
});
