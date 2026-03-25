import { describe, expect, it } from 'vitest';
import { cid } from '@hashtree/core';
import { get } from 'svelte/store';
import {
  getRecentVideoCardInfo,
  recentVideoCardInfoVersion,
  setRecentVideoCardInfo,
} from '../src/stores/homeFeedCache';

describe('home feed recent media cache', () => {
  it('merges repeated updates for the same recent card key', () => {
    const key = '/npub1example/videos/Test';
    const rootCid = cid(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

    setRecentVideoCardInfo(key, {
      videoCount: 0,
      rootCid,
      videoPath: 'video.mp4',
    });

    setRecentVideoCardInfo(key, {
      videoCount: 0,
      thumbnailUrl: '/htree/nhash1example/thumbnail.jpg',
      duration: 42,
    });

    expect(getRecentVideoCardInfo(key)).toEqual({
      videoCount: 0,
      rootCid,
      videoPath: 'video.mp4',
      thumbnailUrl: '/htree/nhash1example/thumbnail.jpg',
      duration: 42,
    });
  });

  it('bumps a reactive version when recent card info changes', () => {
    const key = '/npub1example/videos/Test Reactive';
    const startVersion = get(recentVideoCardInfoVersion);

    setRecentVideoCardInfo(key, {
      videoCount: 0,
      thumbnailUrl: '/htree/nhash1reactive/thumbnail.jpg',
    });

    expect(get(recentVideoCardInfoVersion)).toBeGreaterThan(startVersion);
  });
});
