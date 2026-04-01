import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function loadAppSource() {
  return readFile(resolve(import.meta.dirname, '..', 'src', 'App.svelte'), 'utf8');
}

async function loadShareModalSource() {
  return readFile(resolve(import.meta.dirname, '..', 'src', 'lib', 'ShareModal.svelte'), 'utf8');
}

describe('iris-sites runtime menu markup', () => {
  it('links to the launcher and source views from the runtime menu', async () => {
    const source = await loadAppSource();

    expect(source).toMatch(/href=\{launcherHref\}>\s*sites\.iris\.to\s*<\/a>/);
    expect(source).toMatch(/class="runtime-menu-item" href=\{sourceHref\}>\s*Source\s*<\/a>/);
    expect(source).not.toMatch(/class="runtime-menu-home-link" href=\{sourceHref\}/);
    expect(source).toMatch(/>\s*Show QR\s*<\/button>/);
    expect(source).toContain('<ShareModal />');
    expect(source).toContain('aria-label="Copy sites launcher URL"');
  });

  it('centers the share modal and adapts its palette to system color scheme', async () => {
    const source = await loadShareModalSource();

    expect(source).toContain('align-self: center;');
    expect(source).toContain('justify-self: center;');
    expect(source).toContain('@media (prefers-color-scheme: light)');
    expect(source).toContain('--share-modal-card-background');
    expect(source).not.toContain('Open this site elsewhere');
  });
});
