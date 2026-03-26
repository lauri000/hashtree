import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const playlistPath = path.resolve(process.cwd(), 'src/stores/playlist.ts');
const playlistSource = fs.readFileSync(playlistPath, 'utf8');

describe('playlist scheduling', () => {
  it('does not throttle playlist metadata behind a fixed frontend concurrency gate', () => {
    expect(playlistSource).not.toContain('const CONCURRENCY = 3;');
    expect(playlistSource).not.toContain('if (inFlight >= CONCURRENCY)');
    expect(playlistSource).toContain('await Promise.allSettled(entriesToProcess.map(processEntry));');
  });

  it('does not race playlist card reads against short app-level timeouts', () => {
    expect(playlistSource).not.toContain('PLAYLIST_ROOT_READ_TIMEOUT_MS');
    expect(playlistSource).not.toContain('PLAYLIST_SUBDIR_READ_TIMEOUT_MS');
    expect(playlistSource).not.toContain('PLAYLIST_METADATA_READ_TIMEOUT_MS');
    expect(playlistSource).not.toContain('function withTimeout');
  });
});
