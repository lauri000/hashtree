import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoViewPath = path.resolve(process.cwd(), 'src/components/Video/VideoView.svelte');
const videoViewSource = fs.readFileSync(videoViewPath, 'utf8');

describe('video view playback recovery', () => {
  it('does not speculative-load guessed mutable playlist files on mount', () => {
    expect(videoViewSource).not.toContain('function startDirectVideoFallback');
    expect(videoViewSource).not.toContain('ensureDirectVideoFallback(');
  });

  it('keeps stable fallback candidate advancement for resolved paths', () => {
    expect(videoViewSource).toContain("logVideoDebug('fallback:advance'");
    expect(videoViewSource).toContain('videoFallbackQueue = candidates.slice(1);');
  });

  it('clears stale player errors once a real video file resolves', () => {
    expect(videoViewSource).toContain('async function applyResolvedVideo(entryCid: CID, fileName: string): Promise<boolean> {');
    expect(videoViewSource).toContain('videoFileName = fileName;\n      error = null;');
  });

  it('syncs readable fallback roots and retries once before surfacing missing playlist children', () => {
    expect(videoViewSource).toContain('function syncResolvedRootCache(nextRoot: CID): void {');
    expect(videoViewSource).toContain('syncResolvedRootCache(effectiveRootCid);');
    expect(videoViewSource).toContain("const refreshed = await retryWithFreshTreeRoot('missing-playlist-child');");
  });

  it('preloads the playlist before redirect and reuses cached playlist item cids for child routes', () => {
    expect(videoViewSource).toContain('const existingPlaylist = get(currentPlaylist);');
    expect(videoViewSource).toContain("logVideoDebug('load:playlist-item-cached'");
    expect(videoViewSource).toContain("logVideoDebug('load:playlist-item-listed'");
    expect(videoViewSource).toContain("await loadPlaylist(capturedNpub, capturedTreeName, playlistRootCid, firstVideoId);");
  });
});
