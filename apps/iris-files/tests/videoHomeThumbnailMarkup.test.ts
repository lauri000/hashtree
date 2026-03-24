import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoHomePath = path.resolve(process.cwd(), 'src/components/Video/VideoHome.svelte');
const videoHomeSource = fs.readFileSync(videoHomePath, 'utf8');

describe('video home thumbnail wiring', () => {
  it('passes resolved thumbnail urls into single-video feed cards', () => {
    expect(videoHomeSource).toContain('thumbnailUrl={playlistInfo?.thumbnailUrl}');
  });
});
