import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoHomePath = path.resolve(process.cwd(), 'src/components/Video/VideoHome.svelte');
const videoHomeSource = fs.readFileSync(videoHomePath, 'utf8');

describe('video home recents media wiring', () => {
  it('passes resolved recent media info into recent cards', () => {
    expect(videoHomeSource).toContain('recentCardInfo');
    expect(videoHomeSource).toContain('thumbnailUrl={recentCardInfo?.thumbnailUrl}');
    expect(videoHomeSource).toContain('videoPath={recentCardInfo?.videoPath}');
    expect(videoHomeSource).toContain('rootCid={recentCardInfo?.rootCid ?? null}');
  });

  it('uses feed-style root resolution before waiting on the live tree-root subscription for recents', () => {
    expect(videoHomeSource).toContain('resolveFeedVideoRootCid(video)');
    expect(videoHomeSource).toContain('await resolveFeedVideoRootCidAsync(video, 3000)');
    expect(videoHomeSource).toContain('await waitForTreeRoot(video.ownerNpub, video.treeName, 8000)');
  });

  it('hydrates recents from the shared recent-media cache before kicking off async rediscovery', () => {
    expect(videoHomeSource).toContain('getRecentVideoCardInfo');
    expect(videoHomeSource).toContain('recentVideoCardInfoVersion');
    expect(videoHomeSource).toContain('resolvedRecentCardInfoByKey');
    expect(videoHomeSource).toContain('resolvedRecentCardInfoByKey[video.key]');
  });

  it('does not send audio-only fallback media urls into video-frame thumbnail capture', () => {
    const videoThumbnailPath = path.resolve(process.cwd(), 'src/components/Video/VideoThumbnail.svelte');
    const videoThumbnailSource = fs.readFileSync(videoThumbnailPath, 'utf8');
    expect(videoThumbnailSource).toContain('isAudioMediaFileName');
    expect(videoThumbnailSource).toContain('canUseVideoFrameFallback(url)');
    expect(videoThumbnailSource).toContain('resolvedFallbackVideoUrls');
  });
});
