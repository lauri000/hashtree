import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'src', 'routes');
const treeRouteSource = fs.readFileSync(path.join(root, 'TreeRoute.svelte'), 'utf8');
const nhashRouteSource = fs.readFileSync(path.join(root, 'NHashRoute.svelte'), 'utf8');

describe('git route sidebar gating', () => {
  it('derives generic file-browser visibility instead of caching it as a const', () => {
    expect(treeRouteSource).toContain('let showGenericFileBrowser = $derived(shouldShowGenericFileBrowser());');
    expect(nhashRouteSource).toContain('let showGenericFileBrowser = $derived(shouldShowGenericFileBrowser());');
    expect(treeRouteSource).not.toContain('const showGenericFileBrowser = shouldShowGenericFileBrowser();');
    expect(nhashRouteSource).not.toContain('const showGenericFileBrowser = shouldShowGenericFileBrowser();');
  });
});
