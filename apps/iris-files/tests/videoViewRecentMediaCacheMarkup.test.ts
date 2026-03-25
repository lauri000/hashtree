import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoViewPath = path.resolve(process.cwd(), 'src/components/Video/VideoView.svelte');
const videoViewSource = fs.readFileSync(videoViewPath, 'utf8');

describe('video view recent media cache wiring', () => {
  it('writes the resolved media info for the current route into the shared recent cache', () => {
    expect(videoViewSource).toContain('setRecentVideoCardInfo');
    expect(videoViewSource).toContain('videoThumbnailUrl');
    expect(videoViewSource).toContain('videoFileName');
    expect(videoViewSource).toContain('videoFolderCid || rootCid');
  });
});
