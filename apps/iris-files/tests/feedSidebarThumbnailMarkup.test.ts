import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const feedSidebarPath = path.resolve(process.cwd(), 'src/components/Video/FeedSidebar.svelte');
const feedSidebarSource = fs.readFileSync(feedSidebarPath, 'utf8');

describe('feed sidebar thumbnail wiring', () => {
  it('prefers exact resolved thumbnail urls from the feed store', () => {
    expect(feedSidebarSource).toContain('thumbnailUrl: video.thumbnailUrl');
  });

  it('avoids htree alias fallback when exact feed thumbnails are missing', () => {
    expect(feedSidebarSource).toContain('allowAliasFallback: false');
  });
});
