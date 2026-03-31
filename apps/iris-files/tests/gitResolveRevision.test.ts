import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkType, type CID, type TreeEntry } from '@hashtree/core';

let resolvePathMock = vi.fn();
let readFileMock = vi.fn();
let listDirectoryMock = vi.fn();

vi.mock('../src/store', () => ({
  getTree: () => ({
    resolvePath: (...args: unknown[]) => resolvePathMock(...args),
    readFile: (...args: unknown[]) => readFileMock(...args),
    listDirectory: (...args: unknown[]) => listDirectoryMock(...args),
  }),
  decodeAsText: vi.fn(),
}));

import { resolveRevision } from '../src/utils/git';

function cid(byte: number): CID {
  return { hash: new Uint8Array([byte]), key: undefined } as CID;
}

type FakeNode =
  | { type: 'dir'; entries: Map<string, CID> }
  | { type: 'file'; content: Uint8Array };

function file(content: string): FakeNode {
  return { type: 'file', content: new TextEncoder().encode(content) };
}

function dir(entries: Array<[string, CID]>): FakeNode {
  return { type: 'dir', entries: new Map(entries) };
}

function installFakeTree(nodes: Map<CID, FakeNode>): void {
  resolvePathMock = vi.fn(async (startCid: CID, path: string) => {
    const parts = path.split('/').filter(Boolean);
    let currentCid = startCid;

    for (const part of parts) {
      const node = nodes.get(currentCid);
      if (!node || node.type !== 'dir') return null;
      const nextCid = node.entries.get(part);
      if (!nextCid) return null;
      currentCid = nextCid;
    }

    const node = nodes.get(currentCid);
    if (!node) return null;
    return {
      cid: currentCid,
      type: node.type === 'dir' ? LinkType.Dir : LinkType.Blob,
    };
  });

  readFileMock = vi.fn(async (targetCid: CID) => {
    const node = nodes.get(targetCid);
    return node?.type === 'file' ? node.content : null;
  });

  listDirectoryMock = vi.fn(async (targetCid: CID): Promise<TreeEntry[]> => {
    const node = nodes.get(targetCid);
    if (!node || node.type !== 'dir') return [];

    const entries: TreeEntry[] = [];
    for (const [name, childCid] of node.entries.entries()) {
      const child = nodes.get(childCid);
      if (!child) continue;
      entries.push({
        name,
        cid: childCid,
        size: child.type === 'file' ? child.content.length : 0,
        type: child.type === 'dir' ? LinkType.Dir : LinkType.Blob,
      });
    }
    return entries;
  });
}

describe('resolveRevision', () => {
  beforeEach(() => {
    resolvePathMock = vi.fn();
    readFileMock = vi.fn();
    listDirectoryMock = vi.fn();
  });

  it('returns branch ref SHAs even when the commit object is not present locally', async () => {
    const rootCid = cid(1);
    const gitCid = cid(2);
    const headCid = cid(3);
    const refsCid = cid(4);
    const headsCid = cid(5);
    const masterCid = cid(6);
    const featureCid = cid(7);

    installFakeTree(new Map<CID, FakeNode>([
      [rootCid, dir([['.git', gitCid]])],
      [gitCid, dir([
        ['HEAD', headCid],
        ['refs', refsCid],
      ])],
      [headCid, file('ref: refs/heads/master\n')],
      [refsCid, dir([['heads', headsCid]])],
      [headsCid, dir([
        ['master', masterCid],
        ['feature-ui', featureCid],
      ])],
      [masterCid, file('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')],
      [featureCid, file('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n')],
    ]));

    await expect(resolveRevision(rootCid, 'feature-ui')).resolves.toBe(
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
  });
});
