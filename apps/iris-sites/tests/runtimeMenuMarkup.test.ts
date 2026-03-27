import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src', 'App.svelte'), 'utf8');

describe('runtime menu markup', () => {
  it('uses the launcher URL card itself as the copy target instead of a duplicate copy row', () => {
    expect(appSource).not.toContain('Copy Share URL');
    expect(appSource).not.toContain('Open on Sites');
    expect(appSource).toContain('class="runtime-menu-link-button"');
    expect(appSource).toContain('class="runtime-menu-link-text">{launcherHref}</span>');
    expect(appSource).toContain('class="runtime-menu-copy-icon"');
    expect(appSource).toContain("copyStatus === 'copied' ? 'Copied'");
  });

  it('lets the auto-reload label wrap without forcing the checkbox out of the panel', () => {
    expect(appSource).toContain('class="runtime-menu-toggle-label">Auto-reload on updates</span>');
    expect(appSource).toContain('align-items: flex-start;');
    expect(appSource).toContain('min-width: 0;');
  });

  it('uses an explicit update action instead of a separate status badge', () => {
    expect(appSource).not.toContain('Update available');
    expect(appSource).toContain("class:runtime-menu-item-primary={updateAvailable}");
    expect(appSource).toContain("updateAvailable ? 'Update Now' : 'Reload'");
  });
});
