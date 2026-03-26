import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const feedSidebarPath = path.resolve(process.cwd(), 'src/components/Video/FeedSidebar.svelte');
const feedSidebarSource = fs.readFileSync(feedSidebarPath, 'utf8');

describe('feed sidebar thumbnail wiring', () => {
  it('prefers exact resolved thumbnail urls from the feed store', () => {
    expect(feedSidebarSource).toContain('thumbnailUrl: video.thumbnailUrl');
  });

  it('uses ordered htree thumbnail candidates for sidebar cards', () => {
    expect(feedSidebarSource).toContain('getStableThumbnailCandidateUrls');
    expect(feedSidebarSource).toContain('fallbackImageUrls={thumbnailUrls.slice(1)}');
  });

  it('does not guess common video filenames for sidebar thumbnail fallback', () => {
    expect(feedSidebarSource).toContain('includeCommonFallbacks: false');
  });

  it('passes deterministic poster fallback props for unresolved sidebar media', () => {
    expect(feedSidebarSource).toContain('fallbackTitle={video.title}');
    expect(feedSidebarSource).toContain('fallbackSeed={`${video.ownerNpub ?? \'\'}/${video.treeName ?? video.title}`}');
  });

  it('uses the shorter guessed-thumbnail stall timeout for unresolved sidebar cards', () => {
    expect(feedSidebarSource).toContain('@const imageCandidateStallTimeoutMs = video.thumbnailUrl ? 8000 : 2500');
    expect(feedSidebarSource).toContain('{imageCandidateStallTimeoutMs}');
  });
});
