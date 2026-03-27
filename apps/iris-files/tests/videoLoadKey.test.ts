import { describe, expect, it } from 'vitest';
import { cid, fromHex } from '@hashtree/core';

import { buildVideoLoadKey } from '../src/components/Video/videoLoadKey';

describe('buildVideoLoadKey', () => {
  it('distinguishes roots with the same hash but different decryption keys', () => {
    const hash = fromHex('11'.repeat(32));
    const first = cid(hash, fromHex('22'.repeat(32)));
    const second = cid(hash, fromHex('33'.repeat(32)));

    expect(buildVideoLoadKey(first, 'video/path')).not.toBe(buildVideoLoadKey(second, 'video/path'));
  });

  it('keeps the path in the identity for the same root', () => {
    const root = cid(fromHex('44'.repeat(32)), fromHex('55'.repeat(32)));

    expect(buildVideoLoadKey(root, 'first/path')).not.toBe(buildVideoLoadKey(root, 'second/path'));
  });

  it('preserves hash-only roots for public or unresolved trees', () => {
    const root = cid(fromHex('66'.repeat(32)));

    expect(buildVideoLoadKey(root, 'video/path')).toBe(`${'66'.repeat(32)}::video/path`);
  });
});
