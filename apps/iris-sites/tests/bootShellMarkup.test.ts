import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  HASHTREE_INSTALL_DOCS_HREF,
  PUBLISH_IMMUTABLE_COMMAND,
  PUBLISH_MUTABLE_COMMAND,
} from '../src/lib/launcherContent';

async function loadAppSource() {
  return readFile(resolve(import.meta.dirname, '..', 'src', 'App.svelte'), 'utf8');
}

describe('iris-sites launcher markup', () => {
  it('keeps static suggestions while showing publish instructions', async () => {
    const source = await loadAppSource();

    expect(HASHTREE_INSTALL_DOCS_HREF).toBe(
      'https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree/README.md',
    );
    expect(PUBLISH_IMMUTABLE_COMMAND).toBe('htree add ./dist');
    expect(PUBLISH_MUTABLE_COMMAND).toBe('htree add ./dist --publish my-site');
    expect(source).toContain('{#each launcherSuggestions as suggestion}');
    expect(source).toContain('Publish your own site');
    expect(source).toContain('href={HASHTREE_INSTALL_DOCS_HREF}');
    expect(source).toContain('<code>{PUBLISH_IMMUTABLE_COMMAND}</code>');
    expect(source).toContain('<code>{PUBLISH_MUTABLE_COMMAND}</code>');
    expect(source).toContain('If your directory contains <code>index.html</code>, the CLI prints a');
  });
});
