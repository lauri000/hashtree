import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoThumbnailPath = path.resolve(process.cwd(), 'src/components/Video/VideoThumbnail.svelte');
const videoThumbnailSource = fs.readFileSync(videoThumbnailPath, 'utf8');

describe('video thumbnail fallback wiring', () => {
  it('supports ordered fallback image candidates before giving up to a placeholder', () => {
    expect(videoThumbnailSource).toContain('fallbackImageUrls?: string[] | null');
    expect(videoThumbnailSource).toContain('resolvedImageCandidateUrls');
    expect(videoThumbnailSource).toContain('fallbackImageUrls ?? []');
  });

  it('supports exact video fallback candidates when no image thumbnail is available', () => {
    expect(videoThumbnailSource).toContain('fallbackVideoUrls?: string[] | null');
    expect(videoThumbnailSource).toContain('<video');
    expect(videoThumbnailSource).toContain('const observer = new IntersectionObserver');
    expect(videoThumbnailSource).toContain("rootMargin: '200px'");
    expect(videoThumbnailSource).toContain('captureVideoFrame');
    expect(videoThumbnailSource).toContain('onloadeddata={handleVideoLoadedData}');
    expect(videoThumbnailSource).toContain("video.removeAttribute('src')");
    expect(videoThumbnailSource).toContain('onerror={handleVideoError}');
  });

  it('times out a stalled image candidate without giving up on the whole thumbnail, and still times out hidden video-frame fallbacks', () => {
    expect(videoThumbnailSource).toContain('IMAGE_CANDIDATE_STALL_TIMEOUT_MS');
    expect(videoThumbnailSource).toContain('imageCandidateStallTimeoutMs?: number');
    expect(videoThumbnailSource).toContain('imageCandidateStallTimeoutMs = IMAGE_CANDIDATE_STALL_TIMEOUT_MS');
    expect(videoThumbnailSource).toContain('VIDEO_FALLBACK_LOAD_TIMEOUT_MS');
    expect(videoThumbnailSource).toContain('clearImageLoadTimer');
    expect(videoThumbnailSource).toContain('advanceImageCandidateOrFail');
    expect(videoThumbnailSource).toContain('advanceVideoCandidateOrFail');
    expect(videoThumbnailSource).toContain('onload={handleImageLoad}');
    expect(videoThumbnailSource).toContain('onerror={handleImageError}');
  });

  it('keeps showing the placeholder until the image or exact video-frame fallback has actually loaded', () => {
    expect(videoThumbnailSource).toContain('let imageLoaded = $state(false);');
    expect(videoThumbnailSource).toContain('let imageEl = $state<HTMLImageElement | null>(null);');
    expect(videoThumbnailSource).toContain('imageLoaded = false;');
    expect(videoThumbnailSource).toContain('imageLoaded = true;');
    expect(videoThumbnailSource).toContain('if (image.complete && image.naturalWidth > 0) {');
    expect(videoThumbnailSource).toContain('bind:this={imageEl}');
    expect(videoThumbnailSource).toContain('class:opacity-0={!imageLoaded}');
    expect(videoThumbnailSource).toContain('{#if (!renderedSrc || imageError || !imageLoaded) && !capturedVideoFrameUrl}');
  });

  it('renders a deterministic local poster when no htree thumbnail or frame is available', () => {
    expect(videoThumbnailSource).toContain('fallbackTitle?: string | null');
    expect(videoThumbnailSource).toContain('fallbackSubtitle?: string | null');
    expect(videoThumbnailSource).toContain('fallbackSeed?: string | null');
    expect(videoThumbnailSource).toContain('getPosterPalette');
    expect(videoThumbnailSource).toContain('generated-thumbnail-poster');
    expect(videoThumbnailSource).toContain('data-testid="generated-thumbnail-poster"');
  });
});
