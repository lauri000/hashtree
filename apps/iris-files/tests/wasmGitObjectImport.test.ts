import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkType, type CID } from '@hashtree/core';

vi.mock('../src/store', () => ({
  getTree: vi.fn(),
}));

import { getTree } from '../src/store';
import {
  copyGitObjectPayloadsToWasmFS,
  shouldCopyGitObjectPayloadFile,
  shouldTraverseGitObjectPayloadDir,
} from '../src/utils/wasmGit/objectImport';

function cid(name: string): CID {
  return { hash: new Uint8Array([name.length]) };
}

describe('git object import payload filters', () => {
  it('accepts loose object payload paths and pack payload files', () => {
    expect(shouldTraverseGitObjectPayloadDir('aa')).toBe(true);
    expect(shouldTraverseGitObjectPayloadDir('pack')).toBe(true);
    expect(shouldTraverseGitObjectPayloadDir('info')).toBe(false);

    expect(shouldCopyGitObjectPayloadFile(`aa/${'b'.repeat(38)}`)).toBe(true);
    expect(shouldCopyGitObjectPayloadFile(`pack/pack-${'a'.repeat(40)}.pack`)).toBe(true);
    expect(shouldCopyGitObjectPayloadFile(`pack/pack-${'a'.repeat(40)}.idx`)).toBe(true);
    expect(shouldCopyGitObjectPayloadFile(`pack/pack-${'a'.repeat(40)}.rev`)).toBe(true);
  });

  it('rejects object-db metadata paths', () => {
    expect(shouldCopyGitObjectPayloadFile('info/alternates')).toBe(false);
    expect(shouldCopyGitObjectPayloadFile('info/commit-graph')).toBe(false);
    expect(shouldCopyGitObjectPayloadFile('pack/multi-pack-index')).toBe(false);
    expect(shouldCopyGitObjectPayloadFile('pack/pack-nothex.pack')).toBe(false);
  });
});

describe('copyGitObjectPayloadsToWasmFS', () => {
  const getTreeMock = vi.mocked(getTree);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies only loose objects and pack payloads, skipping metadata', async () => {
    const objectsCid = cid('objects');
    const looseDirCid = cid('aa');
    const packDirCid = cid('pack');
    const infoDirCid = cid('info');
    const looseObjCid = cid('loose-object');
    const packPackCid = cid('pack-pack');
    const packIdxCid = cid('pack-idx');
    const packRevCid = cid('pack-rev');
    const packMidxCid = cid('pack-midx');
    const alternatesCid = cid('alternates');
    const commitGraphCid = cid('commit-graph');

    const packBase = `pack-${'a'.repeat(40)}`;
    const dirs = new Map<CID, Array<{ name: string; cid: CID; type: LinkType }>>([
      [
        objectsCid,
        [
          { name: 'aa', cid: looseDirCid, type: LinkType.Dir },
          { name: 'pack', cid: packDirCid, type: LinkType.Dir },
          { name: 'info', cid: infoDirCid, type: LinkType.Dir },
        ],
      ],
      [
        looseDirCid,
        [
          { name: '1234567890abcdef1234567890abcdef123456', cid: looseObjCid, type: LinkType.Blob },
        ],
      ],
      [
        packDirCid,
        [
          { name: `${packBase}.pack`, cid: packPackCid, type: LinkType.Blob },
          { name: `${packBase}.idx`, cid: packIdxCid, type: LinkType.Blob },
          { name: `${packBase}.rev`, cid: packRevCid, type: LinkType.Blob },
          { name: 'multi-pack-index', cid: packMidxCid, type: LinkType.Blob },
        ],
      ],
      [
        infoDirCid,
        [
          { name: 'alternates', cid: alternatesCid, type: LinkType.Blob },
          { name: 'commit-graph', cid: commitGraphCid, type: LinkType.Blob },
        ],
      ],
    ]);

    const files = new Map<CID, Uint8Array>([
      [looseObjCid, new Uint8Array([1])],
      [packPackCid, new Uint8Array([2])],
      [packIdxCid, new Uint8Array([3])],
      [packRevCid, new Uint8Array([4])],
      [packMidxCid, new Uint8Array([5])],
      [alternatesCid, new Uint8Array([6])],
      [commitGraphCid, new Uint8Array([7])],
    ]);

    const listDirectory = vi.fn(async (entryCid: CID) => dirs.get(entryCid) ?? []);
    const readFile = vi.fn(async (entryCid: CID) => files.get(entryCid) ?? null);
    getTreeMock.mockReturnValue({ listDirectory, readFile } as never);

    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const module = {
      FS: {
        mkdir,
        writeFile,
      },
    } as never;

    await copyGitObjectPayloadsToWasmFS(module, objectsCid, '/repo/.git/objects');

    const writtenPaths = writeFile.mock.calls.map(([path]) => path);
    expect(writtenPaths).toContain('/repo/.git/objects/aa/1234567890abcdef1234567890abcdef123456');
    expect(writtenPaths).toContain(`/repo/.git/objects/pack/${packBase}.pack`);
    expect(writtenPaths).toContain(`/repo/.git/objects/pack/${packBase}.idx`);
    expect(writtenPaths).toContain(`/repo/.git/objects/pack/${packBase}.rev`);
    expect(writtenPaths).not.toContain('/repo/.git/objects/pack/multi-pack-index');
    expect(writtenPaths).not.toContain('/repo/.git/objects/info/alternates');
    expect(writtenPaths).not.toContain('/repo/.git/objects/info/commit-graph');

    const mkdirPaths = mkdir.mock.calls.map(([path]) => path);
    expect(mkdirPaths).toContain('/repo/.git/objects');
    expect(mkdirPaths).toContain('/repo/.git/objects/aa');
    expect(mkdirPaths).toContain('/repo/.git/objects/pack');
    expect(mkdirPaths).not.toContain('/repo/.git/objects/info');
  });
});
