import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoThumbnailPath = path.resolve(process.cwd(), 'src/components/Video/VideoThumbnail.svelte');
const videoThumbnailSource = fs.readFileSync(videoThumbnailPath, 'utf8');

describe('video thumbnail fallback wiring', () => {
  it('supports exact video fallback candidates when no image thumbnail is available', () => {
    expect(videoThumbnailSource).toContain('fallbackVideoUrls?: string[] | null');
    expect(videoThumbnailSource).toContain('<video');
    expect(videoThumbnailSource).toContain('onloadeddata={handleVideoLoadedData}');
    expect(videoThumbnailSource).toContain('onerror={handleVideoError}');
  });
});
