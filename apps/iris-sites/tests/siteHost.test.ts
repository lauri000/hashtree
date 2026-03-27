import { describe, expect, it } from 'vitest';
import { buildIsolatedSiteHref, isPortalShellHost } from '../src/lib/siteHost';

describe('site host routing', () => {
  it('treats the bare sites host as the launcher shell', () => {
    expect(isPortalShellHost('sites.iris.to')).toBe(true);
    expect(isPortalShellHost('sites.hashtree.cc')).toBe(false);
    expect(isPortalShellHost('enshittifier.hashtree.cc')).toBe(false);
  });

  it('keeps the immutable root inside the hash when deriving a wildcard isolated host', async () => {
    const href = await buildIsolatedSiteHref({
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Isolated Site',
      nhash: 'nhash1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      entryPath: 'index.html',
    });

    expect(href).toMatch(/^https:\/\/[a-f0-9]+\.hashtree\.cc\/#\/nhash1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\/index\.html$/);
    expect(href.split('#')[0]).not.toContain('nhash1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
  });

  it('keeps mutable site identities inside the hash when deriving a wildcard isolated host', async () => {
    const href = await buildIsolatedSiteHref({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'apps/iris',
      npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      treeName: 'apps/iris',
      entryPath: 'index.html',
    });

    expect(href).toMatch(/^https:\/\/[a-f0-9]+\.hashtree\.cc\/#\/npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\/apps%2Firis\/index\.html$/);
    expect(href.split('#')[0]).not.toContain('npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
    expect(href.split('#')[0]).not.toContain('apps/iris');
  });
});
