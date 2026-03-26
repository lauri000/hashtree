import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoHomePath = path.resolve(process.cwd(), 'src/components/Video/VideoHome.svelte');
const videoHomeSource = fs.readFileSync(videoHomePath, 'utf8');

describe('video home media scheduling', () => {
  it('does not batch-gate playlist detection behind fixed frontend concurrency windows', () => {
    expect(videoHomeSource).not.toContain('FEED_PLAYLIST_DETECTION_CONCURRENCY');
    expect(videoHomeSource).not.toContain('Promise.all(videos.slice(i, i + FEED_PLAYLIST_DETECTION_CONCURRENCY).map(detectOne))');
  });

  it('does not batch-gate recent media detection behind fixed frontend concurrency windows', () => {
    expect(videoHomeSource).not.toContain('RECENT_MEDIA_DETECTION_CONCURRENCY');
    expect(videoHomeSource).not.toContain('Promise.all(videos.slice(i, i + RECENT_MEDIA_DETECTION_CONCURRENCY).map(detectOne))');
  });
});
