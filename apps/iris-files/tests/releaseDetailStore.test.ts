import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { HashTree, LinkType, MemoryStore, type CID } from '@hashtree/core';

const getTree = vi.fn();
const waitForTreeRoot = vi.fn();
const saveHashtree = vi.fn();
const cacheListeners = new Set<(npub: string, treeName: string) => void>();

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
  onCacheUpdate: (listener: (npub: string, treeName: string) => void) => {
    cacheListeners.add(listener);
    return () => {
      cacheListeners.delete(listener);
    };
  },
}));

describe('createReleaseDetailStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheListeners.clear();
  });

  it('reloads a release when its tree root appears after the initial miss', async () => {
    const store = new MemoryStore();
    const tree = new HashTree({ store });

    const releaseRecord = await tree.putFile(new TextEncoder().encode(JSON.stringify({
      id: 'v0.2.14',
      title: 'v0.2.14',
      created_at: 1,
      published_at: 2,
      assets: [
        { name: 'hashtree-aarch64-apple-darwin.tar.gz', path: 'assets/hashtree-aarch64-apple-darwin.tar.gz', size: 10 },
      ],
    })));
    const notes = await tree.putFile(new TextEncoder().encode('Built from the local release artifacts.'));
    const releaseDir = await tree.putDirectory([
      { name: 'release.json', cid: releaseRecord.cid, size: releaseRecord.size },
      { name: 'notes.md', cid: notes.cid, size: notes.size },
    ]);
    const releaseRoot = await tree.putDirectory([
      { name: 'v0.2.14', cid: releaseDir.cid, size: 0, type: LinkType.Dir },
    ]);

    let currentRoot: CID | null = null;
    getTree.mockReturnValue(tree);
    waitForTreeRoot.mockImplementation(async () => currentRoot);

    const { buildReleaseTreeName, createReleaseDetailStore } = await import('../src/stores/releases');
    const detailStore = createReleaseDetailStore('npub1owner', 'hashtree', 'v0.2.14');

    await vi.waitFor(() => {
      expect(get(detailStore).loading).toBe(false);
    });
    expect(get(detailStore)).toMatchObject({
      item: null,
      error: 'Release not found',
    });

    currentRoot = releaseRoot.cid;
    for (const listener of cacheListeners) {
      listener('npub1owner', buildReleaseTreeName('hashtree'));
    }

    await vi.waitFor(() => {
      expect(get(detailStore).item?.id).toBe('v0.2.14');
    });
    expect(get(detailStore)).toMatchObject({
      loading: false,
      error: null,
    });
  });
});
