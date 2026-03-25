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

  it('keeps the placeholder visible until the playlist thumbnail image has actually loaded', () => {
    expect(playlistCardSource).toContain('let thumbnailLoaded = $state(false);');
    expect(playlistCardSource).toContain('let thumbnailEl = $state<HTMLImageElement | null>(null);');
    expect(playlistCardSource).toContain('thumbnailLoaded = false;');
    expect(playlistCardSource).toContain('thumbnailLoaded = true;');
    expect(playlistCardSource).toContain('if (image.complete && image.naturalWidth > 0) {');
    expect(playlistCardSource).toContain('bind:this={thumbnailEl}');
    expect(playlistCardSource).toContain('class:opacity-0={!thumbnailLoaded}');
    expect(playlistCardSource).toContain('{#if !renderedThumbnailUrl || thumbnailError || !thumbnailLoaded}');
  });
});
