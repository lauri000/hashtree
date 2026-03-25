import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoHomePath = path.resolve(process.cwd(), 'src/components/Video/VideoHome.svelte');
const videoHomeSource = fs.readFileSync(videoHomePath, 'utf8');

describe('video home thumbnail wiring', () => {
  it('passes resolved thumbnail urls into single-video feed cards', () => {
    expect(videoHomeSource).toContain('thumbnailUrl={resolvedVideo?.thumbnailUrl ?? playlistInfo?.thumbnailUrl}');
  });

  it('falls back to htree-derived thumbnails for playlists that have not resolved yet', () => {
    expect(videoHomeSource).toContain('fallbackPlaylistThumbnail');
    expect(videoHomeSource).toContain('allowAliasFallback: true');
  });

  it('refreshes cached playlist info that is missing thumbnails', () => {
    expect(videoHomeSource).toContain('shouldRefreshPlaylistCardInfo');
  });

  it('can resolve feed-only root cids before playlist detection', () => {
    expect(videoHomeSource).toContain('resolveFeedVideoRootCid');
  });

  it('queues uncached feed items for async root resolution even without a sync root cid', () => {
    expect(videoHomeSource).toContain(
      'uncached.push(resolvedRootCid ? { ...video, rootCid: resolvedRootCid } : video);'
    );
  });

  it('retries when async root resolution has not completed yet', () => {
    expect(videoHomeSource).toContain('if (!rootCid) {');
    expect(videoHomeSource).toContain('schedulePlaylistRetry(video);');
  });

  it('rechecks pending feed thumbnails when a tree root arrives later', () => {
    expect(videoHomeSource).toContain('onCacheUpdate((npub, treeName) => {');
  });

  it('can backfill thumbnails from a historical thumbnail-rich root without changing playback routing', () => {
    expect(videoHomeSource).toContain('resolveReadableThumbnailRoot');
  });

  it('hydrates equal-timestamp cached feed entries when they are still missing root cids', () => {
    expect(videoHomeSource).toContain('function shouldSkipFeedEvent');
    expect(videoHomeSource).toContain('return !!existing.rootCid?.hash;');
  });

  it('does not enable decorative hover color extraction for feed cards', () => {
    expect(videoHomeSource).not.toContain('themeHover');
  });
});
