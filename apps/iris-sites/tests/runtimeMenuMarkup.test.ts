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
    expect(appSource).toContain("{#if copyStatus === 'idle'}");
    expect(appSource).toContain('class="runtime-menu-copy-icon"');
    expect(appSource).not.toContain('grid-area: 1 / 1;');
  });

  it('lets the auto-reload label wrap without forcing the checkbox out of the panel', () => {
    expect(appSource).toContain('class="runtime-menu-toggle-label">Auto-reload</span>');
    expect(appSource).toContain('grid-template-columns: minmax(0, 1fr) auto;');
    expect(appSource).toContain('justify-self: end;');
    expect(appSource).toContain('margin: 0;');
    expect(appSource).toContain('box-sizing: border-box;');
  });

  it('only shows a menu action when an update is actually available', () => {
    expect(appSource).not.toContain('Update available');
    expect(appSource).not.toContain('function reloadCurrentSite()');
    expect(appSource).not.toContain('onclick={reloadCurrentSite}');
    expect(appSource).toContain('{#if updateAvailable}');
    expect(appSource).toContain('Update Now');
  });

  it('shows a permalink action for mutable sites once the current version is known', () => {
    expect(appSource).toContain("const permalinkHref = $derived.by(() =>");
    expect(appSource).toContain("buildPermalinkHref(");
    expect(appSource).toContain('{#if currentSite?.kind === \'mutable\' && permalinkHref}');
    expect(appSource).toContain('>Permalink</a>');
  });

  it('includes a direct link back to the iris sites launcher in the runtime menu header', () => {
    expect(appSource).toContain('class="runtime-menu-home-link"');
    expect(appSource).toContain('href="https://sites.iris.to/"');
    expect(appSource).toContain('>iris sites</a>');
  });
});
