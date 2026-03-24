import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoViewPath = path.resolve(process.cwd(), 'src/components/Video/VideoView.svelte');
const videoViewSource = fs.readFileSync(videoViewPath, 'utf8');

describe('video view thumbnail wiring', () => {
  it('uses the exact loaded thumbnail url before any alias fallback', () => {
    expect(videoViewSource).toContain('thumbnailUrl: videoThumbnailUrl');
  });

  it('disables alias fallback for thumbnail color extraction', () => {
    expect(videoViewSource).toContain('allowAliasFallback: false');
  });
});
