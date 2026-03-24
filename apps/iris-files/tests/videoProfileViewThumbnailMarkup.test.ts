import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const profileViewPath = path.resolve(process.cwd(), 'src/components/Video/VideoProfileView.svelte');
const profileViewSource = fs.readFileSync(profileViewPath, 'utf8');

describe('video profile thumbnail wiring', () => {
  it('falls back to htree-derived playlist thumbnails when exact ones are missing', () => {
    expect(profileViewSource).toContain('thumbnailUrl={playlist.thumbnailUrl ?? getStableThumbnailUrl({');
    expect(profileViewSource).toContain('allowAliasFallback: true');
  });
});
