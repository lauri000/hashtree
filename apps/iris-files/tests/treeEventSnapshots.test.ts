import { describe, expect, it } from 'vitest';
import { cid, fromHex, toHex } from '@hashtree/core';
import {
  buildTreeEventPermalink,
  resolveSnapshotRootCid,
  type TreeEventSnapshotInfo,
} from '../src/lib/treeEventSnapshots';

function makeSnapshot(overrides: Partial<TreeEventSnapshotInfo> = {}): TreeEventSnapshotInfo {
  const rootCid = cid(fromHex('1'.repeat(64)), fromHex('2'.repeat(64)));
  return {
    event: {
      id: '3'.repeat(64),
      pubkey: '4'.repeat(64),
      created_at: 1_700_000_000,
      kind: 30078,
      tags: [
        ['d', 'videos/demo'],
        ['l', 'hashtree'],
        ['hash', '1'.repeat(64)],
        ['key', '2'.repeat(64)],
      ],
      content: '',
      sig: '5'.repeat(128),
    },
    treeName: 'videos/demo',
    rootCid,
    visibility: 'public',
    labels: ['hashtree'],
    snapshotCid: cid(fromHex('6'.repeat(64))),
    snapshotNhash: 'nhash1snapshot',
    npub: 'npub1example',
    ...overrides,
  };
}

describe('tree event snapshots', () => {
  it('builds snapshot permalink routes with preserved path and link key', () => {
    const href = buildTreeEventPermalink(
      makeSnapshot(),
      ['nested folder', 'video.mp4'],
      'a'.repeat(64),
    );

    expect(href).toBe('#/nhash1snapshot/nested%20folder/video.mp4?snapshot=1&k=' + 'a'.repeat(64));
  });

  it('derives the public root CID directly from the snapshot', async () => {
    const resolved = await resolveSnapshotRootCid(makeSnapshot());

    expect(resolved).toEqual(makeSnapshot().rootCid);
  });

  it('derives link-visible content keys from the link key in the URL', async () => {
    const linkKey = fromHex('7'.repeat(64));
    const contentKey = fromHex('8'.repeat(64));
    const encryptedKey = contentKey.map((byte, index) => byte ^ linkKey[index]);
    const snapshot = makeSnapshot({
      visibility: 'link-visible',
      rootCid: cid(fromHex('1'.repeat(64))),
      encryptedKey: toHex(encryptedKey),
    });

    const resolved = await resolveSnapshotRootCid(snapshot, toHex(linkKey));

    expect(resolved).toEqual(cid(fromHex('1'.repeat(64)), contentKey));
  });
});
