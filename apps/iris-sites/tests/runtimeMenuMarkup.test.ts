import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function loadAppSource() {
  return readFile(resolve(import.meta.dirname, '..', 'src', 'App.svelte'), 'utf8');
}

describe('iris-sites runtime menu markup', () => {
  it('links to the launcher and source views from the runtime menu', async () => {
    const source = await loadAppSource();

    expect(source).toMatch(/href=\{launcherHref\}>\s*sites\.iris\.to\s*<\/a>/);
    expect(source).toMatch(/href=\{sourceHref\}>\s*source\s*<\/a>/);
    expect(source).toContain('aria-label="Copy sites launcher URL"');
  });
});
