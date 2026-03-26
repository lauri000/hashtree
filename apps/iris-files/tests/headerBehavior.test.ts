import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'src');
const headerSource = fs.readFileSync(path.join(root, 'components', 'Header.svelte'), 'utf8');
const videoAppSource = fs.readFileSync(path.join(root, 'VideoApp.svelte'), 'utf8');
const filesAppSource = fs.readFileSync(path.join(root, 'App.svelte'), 'utf8');
const gitAppSource = fs.readFileSync(path.join(root, 'GitApp.svelte'), 'utf8');
const boardsAppSource = fs.readFileSync(path.join(root, 'BoardsApp.svelte'), 'utf8');
const mapsAppSource = fs.readFileSync(path.join(root, 'MapsApp.svelte'), 'utf8');
const docsAppSource = fs.readFileSync(path.join(root, 'DocsApp.svelte'), 'utf8');

describe('shared header behavior', () => {
  it('uses theme surface color for the scroll tint instead of a hardcoded dark rgb value', () => {
    expect(headerSource).toContain('sticky?: boolean;');
    expect(headerSource).toContain('scrollTint?: boolean;');
    expect(headerSource).toContain('rgb(var(--surface-0) /');
    expect(headerSource).not.toContain('rgba(15, 15, 15,');
  });

  it('lets only the video shell opt into sticky scroll tinting', () => {
    expect(videoAppSource).toMatch(/<Header\s+sticky=\{true\}\s+scrollTint=\{true\}>/s);
    for (const source of [filesAppSource, gitAppSource, boardsAppSource, mapsAppSource, docsAppSource]) {
      expect(source).toContain('<Header>');
      expect(source).not.toContain('scrollTint={true}');
      expect(source).not.toContain('sticky={true}');
    }
  });
});
