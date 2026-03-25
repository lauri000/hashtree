import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const swSource = fs.readFileSync(path.resolve(process.cwd(), 'src/sw.ts'), 'utf8');
const mediaHandlerSource = fs.readFileSync(path.resolve(process.cwd(), 'src/worker/mediaHandler.ts'), 'utf8');

describe('media worker port startup', () => {
  it('starts the service worker message port after registration', () => {
    expect(swSource).toContain('port.start?.();');
  });

  it('starts the worker-side message port after registration', () => {
    expect(mediaHandlerSource).toContain('port.start?.();');
  });
});
