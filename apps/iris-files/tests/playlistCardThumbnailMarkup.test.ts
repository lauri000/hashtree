import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const playlistCardPath = path.resolve(process.cwd(), 'src/components/Video/PlaylistCard.svelte');
const playlistCardSource = fs.readFileSync(playlistCardPath, 'utf8');

describe('playlist card thumbnail wiring', () => {
  it('keeps hover color extraction opt-in instead of always probing thumbnails', () => {
    expect(playlistCardSource).toContain('themeHover?: boolean');
    expect(playlistCardSource).toContain('if (!themeHover) return;');
  });

  it('uses the shared thumbnail candidate pipeline instead of a single brittle image url', () => {
    expect(playlistCardSource).toContain('getStableThumbnailCandidateUrls');
    expect(playlistCardSource).toContain('<VideoThumbnail');
    expect(playlistCardSource).toContain('fallbackImageUrls={thumbnailUrls.slice(1)}');
  });

  it('passes deterministic poster fallback props for playlists without discoverable art', () => {
    expect(playlistCardSource).toContain('fallbackTitle={title}');
    expect(playlistCardSource).toContain('fallbackSubtitle={`${videoCount} video${videoCount === 1 ? \'\' : \'s\'}`}');
    expect(playlistCardSource).toContain('fallbackSeed={`${ownerNpub ?? \'\'}/${treeName ?? title}`}');
  });
});
