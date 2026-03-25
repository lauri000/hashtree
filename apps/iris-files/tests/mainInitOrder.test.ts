import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MAIN_ENTRY_FILES = [
  'src/main.ts',
  'src/main-video.ts',
  'src/main-docs.ts',
  'src/main-git.ts',
  'src/main-maps.ts',
  'src/main-boards.ts',
];

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('app init order', () => {
  it.each(MAIN_ENTRY_FILES)('%s waits for the service worker before starting worker/session init', (relativePath) => {
    const source = readSource(relativePath);
    const swAwaitIndex = source.indexOf('await swPromise;');
    const workerIndex = source.indexOf('const workerPromise = initReadonlyWorker();');
    const sessionIndex = source.indexOf('const sessionPromise = restoreSession();');

    expect(swAwaitIndex).toBeGreaterThan(-1);
    expect(workerIndex).toBeGreaterThan(swAwaitIndex);
    expect(sessionIndex).toBeGreaterThan(swAwaitIndex);
  });

  it('mounts the video app only after the service worker settles', () => {
    const source = readSource('src/main-video.ts');
    const swAwaitIndex = source.indexOf('await swPromise;');
    const workerAwaitIndex = source.indexOf('await workerPromise;');
    const mediaAwaitIndex = source.indexOf('await ensureMediaStreamingReady().catch(() => false);');
    const mountIndex = source.indexOf('mount(VideoApp');

    expect(swAwaitIndex).toBeGreaterThan(-1);
    expect(workerAwaitIndex).toBeGreaterThan(swAwaitIndex);
    expect(mediaAwaitIndex).toBeGreaterThan(workerAwaitIndex);
    expect(mountIndex).toBeGreaterThan(swAwaitIndex);
    expect(mountIndex).toBeGreaterThan(mediaAwaitIndex);
  });
});
