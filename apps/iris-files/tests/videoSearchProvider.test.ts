import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchVideosMock } = vi.hoisted(() => ({
  searchVideosMock: vi.fn(),
}));

vi.mock('../src/stores/searchIndex', () => ({
  searchVideos: searchVideosMock,
}));

import { videoProvider } from '../src/lib/search/videoProvider';

describe('videoProvider', () => {
  beforeEach(() => {
    searchVideosMock.mockReset();
  });

  it('prefers indexed snapshot hrefs over legacy nhash links', async () => {
    searchVideosMock.mockResolvedValue([
      {
        title: 'Demo',
        href: '#/nhash1snapshot/video.mp4?snapshot=1',
        nhash: 'nhash1legacy',
        pubkey: '1'.repeat(64),
        timestamp: 1,
        treeName: 'videos/demo',
      },
    ]);

    const results = await videoProvider.search('demo', 5);

    expect(results[0]?.path).toBe('/nhash1snapshot/video.mp4?snapshot=1');
  });

  it('falls back to user tree paths when no snapshot href is indexed', async () => {
    searchVideosMock.mockResolvedValue([
      {
        title: 'Episode 1',
        pubkey: '2'.repeat(64),
        timestamp: 1,
        treeName: 'videos/My Playlist',
        videoId: 'Episode 1',
      },
    ]);

    const results = await videoProvider.search('episode', 5);

    expect(results[0]?.path).toMatch(/^\/npub1[ac-hj-np-z02-9]+\/videos%2FMy%20Playlist\/Episode%201$/);
  });

  it('uses nhash only as a last fallback', async () => {
    searchVideosMock.mockResolvedValue([
      {
        title: 'Legacy',
        nhash: 'nhash1legacyonly',
        pubkey: '3'.repeat(64),
        timestamp: 1,
      },
    ]);

    const results = await videoProvider.search('legacy', 5);

    expect(results[0]?.path).toBe('/nhash1legacyonly');
  });
});
