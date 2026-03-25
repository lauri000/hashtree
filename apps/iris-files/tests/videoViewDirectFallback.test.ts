import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoViewPath = path.resolve(process.cwd(), 'src/components/Video/VideoView.svelte');
const videoViewSource = fs.readFileSync(videoViewPath, 'utf8');

describe('video view direct fallback guard', () => {
  it('requires a playlist video path prefix before guessing direct fallback media files', () => {
    expect(videoViewSource).toContain("reason: 'no-video-prefix'");
    expect(videoViewSource).toContain('if (!videoPathPrefix)');
  });

  it('only starts direct guessed-path fallback for playlist child routes', () => {
    expect(videoViewSource).toContain('const allowDirectFallback = canStartDirectVideoFallback(capturedIsPlaylistVideo, capturedVideoId);');
    expect(videoViewSource).toContain('!resolvedVideo &&\n      allowDirectFallback &&');
  });
});
