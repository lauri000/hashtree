import { describe, expect, it } from 'vitest';
import { nhashEncode } from '@hashtree/core';
import {
  buildTreeEventSnapshotPermalink,
  parseTreeEventSnapshotPermalink,
  type TreeEventSnapshotPermalink,
} from '../src/treeEventSnapshotPermalinks.js';

const SNAPSHOT_NHASH = nhashEncode('6'.repeat(64));

function permalink(overrides: Partial<TreeEventSnapshotPermalink> = {}): TreeEventSnapshotPermalink {
  return {
    snapshotNhash: SNAPSHOT_NHASH,
    path: ['index.html'],
    ...overrides,
  };
}

describe('tree event snapshot permalinks', () => {
  it('serializes snapshot permalinks with encoded paths and link keys', () => {
    expect(buildTreeEventSnapshotPermalink(permalink({
      path: ['nested folder', 'video.mp4'],
      linkKey: 'a'.repeat(64),
    }))).toBe(`${SNAPSHOT_NHASH}/nested%20folder/video.mp4?snapshot=1&k=${'a'.repeat(64)}`);
  });

  it('supports hash-route prefixes when serializing', () => {
    expect(buildTreeEventSnapshotPermalink(permalink(), { prefix: '#/' })).toBe(
      `#/${SNAPSHOT_NHASH}/index.html?snapshot=1`,
    );
  });

  it('parses htree snapshot urls', () => {
    expect(parseTreeEventSnapshotPermalink(
      `htree://${SNAPSHOT_NHASH}/docs/index.html?snapshot=1&k=${'b'.repeat(64)}`,
    )).toEqual({
      snapshotNhash: SNAPSHOT_NHASH,
      path: ['docs', 'index.html'],
      linkKey: 'b'.repeat(64),
    });
  });

  it('parses portal hash urls', () => {
    expect(parseTreeEventSnapshotPermalink(
      `https://sites.iris.to/#/${SNAPSHOT_NHASH}/index.html?snapshot=1`,
    )).toEqual({
      snapshotNhash: SNAPSHOT_NHASH,
      path: ['index.html'],
    });
  });

  it('rejects plain immutable nhash urls without snapshot markers', () => {
    expect(parseTreeEventSnapshotPermalink(`htree://${SNAPSHOT_NHASH}/index.html`)).toBeNull();
  });

  it('rejects invalid link keys', () => {
    expect(parseTreeEventSnapshotPermalink(
      `htree://${SNAPSHOT_NHASH}/index.html?snapshot=1&k=oops`,
    )).toBeNull();
  });
});
