import { describe, expect, it } from 'vitest';

import {
  getInitialPlaylistItemTitle,
  getVideoDisplayTitle,
  isGeneratedPlaylistVideoId,
} from '../src/lib/videoDisplayTitle';

describe('video display title helpers', () => {
  it('recognizes generated playlist video ids', () => {
    expect(isGeneratedPlaylistVideoId('video_1767136152580')).toBe(true);
    expect(isGeneratedPlaylistVideoId('video_demo')).toBe(false);
    expect(isGeneratedPlaylistVideoId('Music')).toBe(false);
  });

  it('suppresses synthetic playlist ids in initial sidebar titles', () => {
    expect(getInitialPlaylistItemTitle('video_1767136152580')).toBe('');
    expect(getInitialPlaylistItemTitle('Angel Sword - Break the Chains')).toBe('Angel Sword - Break the Chains');
  });

  it('falls back to the playlist name instead of a synthetic current video id', () => {
    expect(getVideoDisplayTitle({
      currentVideoId: 'video_1767136152580',
      treeName: 'videos/Music',
    })).toBe('Music');
  });

  it('still prefers explicit metadata titles and normal ids', () => {
    expect(getVideoDisplayTitle({
      videoTitle: 'Gjallarhorn - Sjofn [2000] FULL ALBUM',
      currentVideoId: 'video_1767136152580',
      treeName: 'videos/Music',
    })).toBe('Gjallarhorn - Sjofn [2000] FULL ALBUM');

    expect(getVideoDisplayTitle({
      currentVideoId: 'Intro',
      treeName: 'videos/Music',
    })).toBe('Intro');
  });
});
