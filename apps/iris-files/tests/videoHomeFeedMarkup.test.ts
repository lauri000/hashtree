import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoHomePath = path.resolve(process.cwd(), 'src/components/Video/VideoHome.svelte');
const videoHomeSource = fs.readFileSync(videoHomePath, 'utf8');

describe('video home feed media wiring', () => {
  it('uses resolved shared feed media for home grid cards', () => {
    expect(videoHomeSource).toContain('resolvedFeedVideoByKey');
    expect(videoHomeSource).toContain('resolvedFeedVideoByKey.get(video.key)');
    expect(videoHomeSource).toContain('thumbnailUrl={resolvedVideo?.thumbnailUrl ?? playlistInfo?.thumbnailUrl}');
    expect(videoHomeSource).toContain('videoPath={resolvedVideo?.videoPath ?? playlistInfo?.videoPath ?? video.videoPath}');
  });
});
