import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromHex, nhashEncode } from '@hashtree/core';
import {
  getStableFileUrl,
  getStablePathUrl,
  getThumbnailUrlFromCid,
  getStableThumbnailUrl,
  getStableVideoCandidateUrls,
} from '../src/lib/mediaUrl';

afterEach(() => {
  vi.unstubAllGlobals();
});

function installWindow(): void {
  vi.stubGlobal('window', {
    location: {
      protocol: 'http:',
      hostname: '127.0.0.1',
      search: '',
    },
  });
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-media-client',
  });
}

describe('mediaUrl thumbnail helpers', () => {
  it('prefers immutable file urls when the resolved cid is known', () => {
    installWindow();
    const fileCid = {
      hash: fromHex('4'.repeat(64)),
      key: fromHex('5'.repeat(64)),
    };

    expect(
      getStableFileUrl({
        cid: fileCid,
        npub: 'npub1example',
        treeName: 'videos/Test Clip',
        path: 'clips/demo reel/video.mp4',
      }),
    ).toBe(
      `/htree/${nhashEncode(fileCid)}/video.mp4?htree_c=test-media-client`,
    );
  });

  it('drops playlist subdirectory prefixes once the file cid is known', () => {
    installWindow();
    const fileCid = {
      hash: fromHex('8'.repeat(64)),
      key: fromHex('9'.repeat(64)),
    };

    expect(
      getStableFileUrl({
        cid: fileCid,
        npub: 'npub1example',
        treeName: 'videos/Music',
        path: 'video_1767136282070/video.mp4',
      }),
    ).toBe(
      `/htree/${nhashEncode(fileCid)}/video.mp4?htree_c=test-media-client`,
    );
  });

  it('falls back to mutable file urls when no resolved cid is available', () => {
    installWindow();

    expect(
      getStableFileUrl({
        npub: 'npub1example',
        treeName: 'videos/Test Clip',
        path: 'clips/demo reel/video.mp4',
      }),
    ).toBe(
      '/htree/npub1example/videos%2FTest%20Clip/clips/demo%20reel/video.mp4?htree_c=test-media-client',
    );
  });

  it('preserves full relative paths for immutable path urls', () => {
    installWindow();
    const rootCid = {
      hash: fromHex('a'.repeat(64)),
      key: fromHex('b'.repeat(64)),
    };

    expect(
      getStablePathUrl({
        rootCid,
        npub: 'npub1example',
        treeName: 'videos/Test Clip',
        path: 'clips/demo reel/video.mp4',
      }),
    ).toBe(
      `/htree/${nhashEncode(rootCid)}/clips/demo%20reel/video.mp4?htree_c=test-media-client`,
    );
  });

  it('prefers the exact resolved video path before common fallback filenames', () => {
    installWindow();
    const rootCid = {
      hash: fromHex('c'.repeat(64)),
      key: fromHex('d'.repeat(64)),
    };

    expect(
      getStableVideoCandidateUrls({
        rootCid,
        npub: 'npub1example',
        treeName: 'videos/Test Clip',
        videoPath: 'capture/final-cut.mov',
      }),
    ).toEqual([
      `/htree/${nhashEncode(rootCid)}/capture/final-cut.mov?htree_c=test-media-client`,
      `/htree/${nhashEncode(rootCid)}/video.mp4?htree_c=test-media-client`,
      `/htree/${nhashEncode(rootCid)}/video.webm?htree_c=test-media-client`,
      `/htree/${nhashEncode(rootCid)}/video.mov?htree_c=test-media-client`,
      `/htree/${nhashEncode(rootCid)}/video.mkv?htree_c=test-media-client`,
      `/htree/${nhashEncode(rootCid)}/video.m4v?htree_c=test-media-client`,
      `/htree/${nhashEncode(rootCid)}/video.avi?htree_c=test-media-client`,
    ]);
  });

  it('builds immutable thumbnail urls from a known root cid', () => {
    installWindow();
    const rootCid = {
      hash: fromHex('1'.repeat(64)),
      key: fromHex('2'.repeat(64)),
    };

    expect(getThumbnailUrlFromCid(rootCid)).toBe(
      `/htree/${nhashEncode(rootCid)}/thumbnail?htree_c=test-media-client`,
    );
  });

  it('encodes nested playlist thumbnail paths for immutable urls', () => {
    installWindow();
    const rootCid = {
      hash: fromHex('3'.repeat(64)),
    };

    expect(getThumbnailUrlFromCid(rootCid, 'clips/demo reel')).toBe(
      `/htree/${nhashEncode(rootCid)}/clips/demo%20reel/thumbnail?htree_c=test-media-client`,
    );
  });

  it('prefers immutable thumbnail urls when a root cid is known', () => {
    installWindow();
    const rootCid = {
      hash: fromHex('6'.repeat(64)),
    };

    expect(
      getStableThumbnailUrl({
        rootCid,
        npub: 'npub1example',
        treeName: 'videos/Test Clip',
        videoId: 'clips/demo reel',
        hashPrefix: 'deadbeef',
      }),
    ).toBe(`/htree/${nhashEncode(rootCid)}/clips/demo%20reel/thumbnail?htree_c=test-media-client`);
  });

  it('falls back to mutable thumbnail urls when no root cid is available', () => {
    installWindow();

    expect(
      getStableThumbnailUrl({
        npub: 'npub1example',
        treeName: 'videos/Test Clip',
        videoId: 'clips/demo reel',
        hashPrefix: 'deadbeef',
      }),
    ).toBe(
      '/htree/npub1example/videos%2FTest%20Clip/clips/demo%20reel/thumbnail?v=deadbeef&htree_c=test-media-client',
    );
  });

  it('can disable alias fallback when a caller only wants exact thumbnail urls', () => {
    installWindow();

    expect(
      getStableThumbnailUrl({
        rootCid: {
          hash: fromHex('8'.repeat(64)),
        },
        npub: 'npub1example',
        treeName: 'videos/Test Clip',
        videoId: 'clips/demo reel',
        allowAliasFallback: false,
      }),
    ).toBeNull();
  });

  it('can fall back to mutable thumbnail urls when alias fallback is enabled', () => {
    installWindow();

    expect(
      getStableThumbnailUrl({
        npub: 'npub1example',
        treeName: 'videos/Test Clip',
        videoId: 'clips/demo reel',
        hashPrefix: 'deadbeef',
        allowAliasFallback: true,
      }),
    ).toBe(
      '/htree/npub1example/videos%2FTest%20Clip/clips/demo%20reel/thumbnail?v=deadbeef&htree_c=test-media-client',
    );
  });
});
