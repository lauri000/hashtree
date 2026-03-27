import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoViewPath = path.resolve(process.cwd(), 'src/components/Video/VideoView.svelte');
const videoViewSource = fs.readFileSync(videoViewPath, 'utf8');

describe('video view directory fallback', () => {
  it('still probes canonical media filenames when directory listing is empty or lacks a playable entry', () => {
    expect(videoViewSource).toContain(
      '!videoDirEntries || videoDirEntries.length === 0 || !findPlayableMediaEntry(videoDirEntries)'
    );
  });

  it('prefers stable tree-path media urls before direct file-cid urls for resolved videos', () => {
    expect(videoViewSource).toContain('function buildResolvedVideoUrl(');
    expect(videoViewSource).toContain('const treePathUrl = getStablePathUrl({');
    expect(videoViewSource).toContain('return getStableFileUrl({');
  });

  it('keeps the current route source alive while tree roots for the same url refresh in the background', () => {
    expect(videoViewSource).toContain("logVideoDebug('load:hold-existing-no-root'");
    expect(videoViewSource).toContain("logVideoDebug('load:refresh-existing'");
  });

  it('does not prepend the playlist subdirectory twice once a resolved video root is known', () => {
    expect(videoViewSource).toContain('capturedTreeName,');
    expect(videoViewSource).toContain('fileName,');
    expect(videoViewSource).not.toContain('capturedTreeName,\n        videoPathPrefix + fileName,');
  });

  it('falls back to mutable tree-path video candidates before declaring the video missing', () => {
    expect(videoViewSource).toContain('startMutableVideoFallback(videoDirCid, capturedNpub, capturedTreeName, videoPathPrefix)');
    expect(videoViewSource).toContain("mode: rootCidValue ? 'stable-root-path' : 'tree-path'");
    expect(videoViewSource).toContain('function buildStableVideoCandidates(');
  });

  it('tries feed-style root resolution when the tree root store is still empty', () => {
    expect(videoViewSource).toContain('resolveFeedVideoRootCidAsync({');
    expect(videoViewSource).toContain('if (getRouteRootKey(npub, treeName, currentVideoId) !== routeRootKey || effectiveRouteRootCid) {');
    expect(videoViewSource).toContain("logVideoDebug('root:fallback-resolved'");
  });

  it('pins recovered playable roots for the current route so stale resolver roots do not thrash playback', () => {
    expect(videoViewSource).toContain('let routeRootOverride = $state<CID | null>(null);');
    expect(videoViewSource).toContain('function setRouteRootOverride(');
    expect(videoViewSource).toContain('let effectiveRouteRootCid = $derived.by(() => {');
    expect(videoViewSource).toContain("setRouteRootOverride(routeKey, currentStoreRoot, 'store-first');");
    expect(videoViewSource).toContain("setRouteRootOverride(routeRootKey, fallbackSeedRoot, 'feed-fallback-seed');");
    expect(videoViewSource).toContain("setRouteRootOverride(capturedRouteRootKey, effectiveRootCid, 'readable-fallback');");
    expect(videoViewSource).toContain("setRouteRootOverride(capturedRouteRootKey, readableRootCid, 'readable-fallback');");
    expect(videoViewSource).toContain("setRouteRootOverride(capturedRouteRootKey, refreshedRoot, `refresh:${reason}`);");
    expect(videoViewSource).not.toContain('updateSubscriptionCache(');
  });

  it('renders audio roots through an audio element instead of forcing them into the video tag', () => {
    expect(videoViewSource).toContain('let isAudioOnly = $derived(');
    expect(videoViewSource).toContain('<audio');
    expect(videoViewSource).toContain('Your browser does not support the audio tag.');
  });
});
