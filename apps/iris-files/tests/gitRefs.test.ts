import { describe, expect, it } from 'vitest';
import { LinkType, type CID, type TreeEntry } from '@hashtree/core';
import { getRefs } from '../src/utils/wasmGit/branch';
import { parsePackedRefs, type GitTreeReader } from '../src/utils/wasmGit/refs';

function cid(label: string): CID {
  return { hash: new TextEncoder().encode(label), key: undefined } as CID;
}

type Node =
  | {
      type: 'dir';
      entries: Map<string, CID>;
    }
  | {
      type: 'file';
      content: Uint8Array;
    };

function createFakeTree(nodes: Map<CID, Node>): GitTreeReader {
  return {
    async resolvePath(startCid, path) {
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
    },

    async readFile(fileCid) {
      const node = nodes.get(fileCid);
      return node?.type === 'file' ? node.content : null;
    },

    async listDirectory(dirCid) {
      const node = nodes.get(dirCid);
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
    },
  };
}

function file(content: string): Node {
  return {
    type: 'file',
    content: new TextEncoder().encode(content),
  };
}

function dir(entries: Array<[string, CID]>): Node {
  return {
    type: 'dir',
    entries: new Map(entries),
  };
}

describe('git refs reader', () => {
  it('parses packed refs and preserves peeled annotated-tag commits', () => {
    const refs = parsePackedRefs(`
# pack-refs with: peeled fully-peeled sorted
1111111111111111111111111111111111111111 refs/heads/main
2222222222222222222222222222222222222222 refs/tags/v1.0.0
^3333333333333333333333333333333333333333
4444444444444444444444444444444444444444 refs/tags/releases/v0.9.0
`.trim());

    expect(refs.get('refs/heads/main')).toEqual({
      sha: '1111111111111111111111111111111111111111',
    });
    expect(refs.get('refs/tags/v1.0.0')).toEqual({
      sha: '2222222222222222222222222222222222222222',
      peeled: '3333333333333333333333333333333333333333',
    });
    expect(refs.get('refs/tags/releases/v0.9.0')).toEqual({
      sha: '4444444444444444444444444444444444444444',
    });
  });

  it('merges loose and packed refs, keeps nested names, and groups tags by commit', async () => {
    const rootCid = cid('root');
    const gitCid = cid('git');
    const headCid = cid('head');
    const packedRefsCid = cid('packed-refs');
    const refsCid = cid('refs');
    const headsCid = cid('heads');
    const headsReleaseCid = cid('heads-release');
    const tagsCid = cid('tags');

    const mainHeadCid = cid('main-head');
    const releaseHeadCid = cid('release-head');
    const looseTagCid = cid('tag-v1');

    const nodes = new Map<CID, Node>([
      [rootCid, dir([['.git', gitCid]])],
      [gitCid, dir([
        ['HEAD', headCid],
        ['packed-refs', packedRefsCid],
        ['refs', refsCid],
      ])],
      [headCid, file('ref: refs/heads/release/v1\n')],
      [packedRefsCid, file(`
# pack-refs with: peeled fully-peeled sorted
cccccccccccccccccccccccccccccccccccccccc refs/heads/hotfix/packed
dddddddddddddddddddddddddddddddddddddddd refs/tags/v1.0.0
eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee refs/tags/releases/v0.9.0
^9999999999999999999999999999999999999999
`.trim())],
      [refsCid, dir([
        ['heads', headsCid],
        ['tags', tagsCid],
      ])],
      [headsCid, dir([
        ['main', mainHeadCid],
        ['release', headsReleaseCid],
      ])],
      [headsReleaseCid, dir([
        ['v1', releaseHeadCid],
      ])],
      [mainHeadCid, file('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')],
      [releaseHeadCid, file('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n')],
      [tagsCid, dir([
        ['v1.0.0', looseTagCid],
      ])],
      [looseTagCid, file('ffffffffffffffffffffffffffffffffffffffff\n')],
    ]);

    const refs = await getRefs(rootCid, {
      tree: createFakeTree(nodes),
      resolveRevisionToCommit: async (_repoCid, revision) => {
        if (revision === 'refs/tags/v1.0.0') {
          return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        }
        if (revision === 'refs/tags/releases/v0.9.0') {
          return '9999999999999999999999999999999999999999';
        }
        return null;
      },
    });

    expect(refs.currentBranch).toBe('release/v1');
    expect(refs.branches).toEqual(['hotfix/packed', 'main', 'release/v1']);
    expect(refs.tags).toEqual(['releases/v0.9.0', 'v1.0.0']);
    expect(refs.tagsByCommit).toEqual({
      '9999999999999999999999999999999999999999': ['releases/v0.9.0'],
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': ['v1.0.0'],
    });
  });
});
