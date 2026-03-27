import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'src', 'components', 'Viewer');
const viewerSource = fs.readFileSync(path.join(root, 'Viewer.svelte'), 'utf8');
const directoryActionsSource = fs.readFileSync(path.join(root, 'DirectoryActions.svelte'), 'utf8');

describe('open site links markup', () => {
  it('surfaces an Open Site action for HTML file viewing', () => {
    expect(viewerSource).toContain('data-testid="viewer-open-site"');
    expect(viewerSource).toContain('Open Site');
  });

  it('surfaces an Open Site action for directory site roots', () => {
    expect(directoryActionsSource).toContain('data-testid="directory-open-site"');
    expect(directoryActionsSource).toContain('Open Site');
  });
});
