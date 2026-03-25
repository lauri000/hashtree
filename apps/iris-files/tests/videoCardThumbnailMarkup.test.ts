import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoCardPath = path.resolve(process.cwd(), 'src/components/Video/VideoCard.svelte');
const videoCardSource = fs.readFileSync(videoCardPath, 'utf8');

describe('video card thumbnail wiring', () => {
  it('uses ordered htree thumbnail candidates instead of a single fragile thumbnail url', () => {
    expect(videoCardSource).toContain('getStableThumbnailCandidateUrls');
    expect(videoCardSource).toContain('fallbackImageUrls={thumbnailUrls.slice(1)}');
  });

  it('passes exact video fallback candidates to the thumbnail component', () => {
    expect(videoCardSource).toContain('getStableVideoCandidateUrls');
    expect(videoCardSource).toContain('includeCommonFallbacks: false');
    expect(videoCardSource).toContain('fallbackVideoUrls={thumbnailVideoUrls}');
  });

  it('uses a shorter stall timeout for guessed thumbnails than for explicit resolved thumbnails', () => {
    expect(videoCardSource).toContain('let imageCandidateStallTimeoutMs = $derived(propThumbnailUrl ? 8000 : 2500);');
    expect(videoCardSource).toContain('{imageCandidateStallTimeoutMs}');
  });
});
