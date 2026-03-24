import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoCardPath = path.resolve(process.cwd(), 'src/components/Video/VideoCard.svelte');
const videoCardSource = fs.readFileSync(videoCardPath, 'utf8');

describe('video card thumbnail wiring', () => {
  it('avoids htree alias fallback when exact thumbnail urls are unavailable', () => {
    expect(videoCardSource).toContain('allowAliasFallback: false');
  });

  it('passes exact video fallback candidates to the thumbnail component', () => {
    expect(videoCardSource).toContain('getStableVideoCandidateUrls');
    expect(videoCardSource).toContain('fallbackVideoUrls={thumbnailVideoUrls}');
  });
});
