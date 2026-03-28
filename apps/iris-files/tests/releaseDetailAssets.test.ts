import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore } from '@hashtree/core';

const getTree = vi.fn();
const waitForTreeRoot = vi.fn();
const saveHashtree = vi.fn();
const onCacheUpdate = vi.fn();

vi.mock('../src/store', () => ({
  getTree,
  decodeAsText: (data: Uint8Array) => new TextDecoder().decode(data),
}));

vi.mock('../src/stores/treeRoot', () => ({
  waitForTreeRoot,
}));

vi.mock('../src/nostr', () => ({
  saveHashtree,
}));

vi.mock('../src/treeRootCache', () => ({
  onCacheUpdate,
}));

describe('fetchReleaseDetail assets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses release.json asset metadata when present', async () => {
    const store = new MemoryStore();
    const tree = new HashTree({ store });

    const releaseRecord = await tree.putFile(new TextEncoder().encode(JSON.stringify({
      id: 'v0.2.14',
      title: 'v0.2.14',
      created_at: 1,
      published_at: 2,
      assets: [
        { name: 'hashtree-aarch64-apple-darwin.tar.gz', path: 'assets/hashtree-aarch64-apple-darwin.tar.gz', size: 10 },
        { name: 'hashtree-aarch64-apple-darwin.sha256', path: 'assets/hashtree-aarch64-apple-darwin.sha256', size: 20 },
      ],
    })));
    const releaseDir = await tree.putDirectory([
      { name: 'release.json', cid: releaseRecord.cid, size: releaseRecord.size },
    ]);
    const releaseRoot = await tree.putDirectory([
      { name: 'v0.2.14', cid: releaseDir.cid, size: 0, type: LinkType.Dir },
    ]);

    getTree.mockReturnValue(tree);
    waitForTreeRoot.mockResolvedValue(releaseRoot.cid);

    const { fetchReleaseDetail } = await import('../src/stores/releases');
    const release = await fetchReleaseDetail('npub1owner', 'hashtree', 'v0.2.14');

    expect(release?.assets).toEqual([
      { name: 'hashtree-aarch64-apple-darwin.tar.gz', path: 'assets/hashtree-aarch64-apple-darwin.tar.gz', size: 10 },
      { name: 'hashtree-aarch64-apple-darwin.sha256', path: 'assets/hashtree-aarch64-apple-darwin.sha256', size: 20 },
    ]);
  });

  it('lists assets even when the assets entry link type is mislabeled', async () => {
    const store = new MemoryStore();
    const tree = new HashTree({ store });

    const assetTar = await tree.putFile(new TextEncoder().encode('tarball'));
    const assetSha = await tree.putFile(new TextEncoder().encode('checksum'));
    const assetsDir = await tree.putDirectory([
      { name: 'hashtree-aarch64-apple-darwin.tar.gz', cid: assetTar.cid, size: assetTar.size },
      { name: 'hashtree-aarch64-apple-darwin.sha256', cid: assetSha.cid, size: assetSha.size },
    ]);
    const releaseRecord = await tree.putFile(new TextEncoder().encode(JSON.stringify({
      id: 'v0.2.14',
      title: 'v0.2.14',
      created_at: 1,
      published_at: 2,
    })));
    const releaseDir = await tree.putDirectory([
      { name: 'release.json', cid: releaseRecord.cid, size: releaseRecord.size },
      { name: 'assets', cid: assetsDir.cid, size: 0, type: LinkType.Blob },
    ]);
    const releaseRoot = await tree.putDirectory([
      { name: 'v0.2.14', cid: releaseDir.cid, size: 0, type: LinkType.Dir },
    ]);

    getTree.mockReturnValue(tree);
    waitForTreeRoot.mockResolvedValue(releaseRoot.cid);

    const { fetchReleaseDetail } = await import('../src/stores/releases');
    const release = await fetchReleaseDetail('npub1owner', 'hashtree', 'v0.2.14');

    const actualAssets = [...(release?.assets ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    expect(actualAssets).toEqual([
      {
        name: 'hashtree-aarch64-apple-darwin.sha256',
        path: 'assets/hashtree-aarch64-apple-darwin.sha256',
        size: assetSha.size,
        cid: assetSha.cid,
      },
      {
        name: 'hashtree-aarch64-apple-darwin.tar.gz',
        path: 'assets/hashtree-aarch64-apple-darwin.tar.gz',
        size: assetTar.size,
        cid: assetTar.cid,
      },
    ]);
  });
});
