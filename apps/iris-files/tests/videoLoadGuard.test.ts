import { describe, expect, it } from 'vitest';
import { cid, fromHex } from '@hashtree/core';

import { buildPlaylistRedirectHash, consumePendingPlaylistRedirect, isActiveVideoLoad, rememberPendingPlaylistRedirect } from '../src/components/Video/videoLoadGuard';

describe('videoLoadGuard', () => {
  it('treats the matching load key as active', () => {
    expect(isActiveVideoLoad('root-a:Music', 'root-a:Music')).toBe(true);
  });

  it('treats an older playlist load as stale after the root changes', () => {
    expect(isActiveVideoLoad('root-b:Music', 'root-a:Music')).toBe(false);
  });

  it('skips playlist redirects from stale loads', () => {
    expect(
      buildPlaylistRedirectHash({
        activeLoadKey: 'root-b:Music',
        expectedLoadKey: 'root-a:Music',
        npub: 'npub1example',
        treeName: 'videos/Music',
        firstVideoId: 'video_1767136152580',
      })
    ).toBeNull();
  });

  it('builds an encoded redirect for the active playlist load', () => {
    expect(
      buildPlaylistRedirectHash({
        activeLoadKey: 'root-a:Music',
        expectedLoadKey: 'root-a:Music',
        npub: 'npub1example',
        treeName: 'videos/Heavy Music',
        firstVideoId: 'video demo/01',
      })
    ).toBe('#/npub1example/videos%2FHeavy%20Music/video%20demo%2F01');
  });

  it('remembers a pending playlist redirect long enough for the child route to consume it once', () => {
    const rootCid = cid(fromHex('11'.repeat(32)));
    const videoCid = cid(fromHex('22'.repeat(32)));
    rememberPendingPlaylistRedirect({
      npub: 'npub1example',
      treeName: 'videos/Music',
      videoId: 'video_123',
      rootCid,
      videoCid,
    });

    expect(consumePendingPlaylistRedirect('npub1example', 'videos/Music', 'video_123')).toEqual({
      rootCid,
      videoCid,
    });
    expect(consumePendingPlaylistRedirect('npub1example', 'videos/Music', 'video_123')).toBeNull();
  });
});
