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

  it('resolves latest through the tree path before reading release metadata', async () => {
    const releaseJson = new TextEncoder().encode(JSON.stringify({
      id: 'v0.2.16',
      title: 'v0.2.16',
      created_at: 1,
      published_at: 2,
      assets: [
        { name: 'iris-v0.2.16-macos-arm64.zip', path: 'assets/iris-v0.2.16-macos-arm64.zip', size: 123 },
      ],
    }));
    const notes = new TextEncoder().encode('locally built release');
    const fakeTree = {
      resolvePath: vi.fn(async (cid: string, path: string) => {
        if (cid === 'root-cid' && path === 'latest') {
          return { name: 'latest', cid: 'release-dir-cid', type: LinkType.Dir };
        }
        if (cid === 'release-dir-cid' && path === 'release.json') {
          return { name: 'release.json', cid: 'release-json-cid', type: LinkType.Blob };
        }
        if (cid === 'release-dir-cid' && path === 'notes.md') {
          return { name: 'notes.md', cid: 'notes-cid', type: LinkType.Blob };
        }
        if (cid === 'release-dir-cid' && path === 'assets') {
          return { name: 'assets', cid: 'assets-dir-cid', type: LinkType.Blob };
        }
        return null;
      }),
      readFile: vi.fn(async (cid: string) => {
        if (cid === 'release-json-cid') return releaseJson;
        if (cid === 'notes-cid') return notes;
        return null;
      }),
      listDirectory: vi.fn(async (cid: string) => {
        if (cid === 'assets-dir-cid') {
          return [{ name: 'iris-v0.2.16-macos-arm64.zip', cid: 'asset-cid', size: 123, type: LinkType.Blob }];
        }
        if (cid === 'root-cid') {
          return [{ name: 'latest', cid: 'latest-link-cid', type: LinkType.Dir }];
        }
        return [];
      }),
    };

    getTree.mockReturnValue(fakeTree);
    waitForTreeRoot.mockResolvedValue('root-cid');

    const { fetchReleaseDetail } = await import('../src/stores/releases');
    const release = await fetchReleaseDetail('npub1owner', 'hashtree', 'latest');

    expect(release).toMatchObject({
      id: 'v0.2.16',
      title: 'v0.2.16',
      notes: 'locally built release',
      assets: [
        {
          name: 'iris-v0.2.16-macos-arm64.zip',
          path: 'assets/iris-v0.2.16-macos-arm64.zip',
          size: 123,
          cid: 'asset-cid',
        },
      ],
    });
    expect(fakeTree.resolvePath).toHaveBeenCalledWith('root-cid', 'latest');
    expect(fakeTree.resolvePath).toHaveBeenCalledWith('release-dir-cid', 'release.json');
  });
});
