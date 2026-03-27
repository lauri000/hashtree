import { describe, expect, it } from 'vitest';
import { nhashDecode, nhashEncode, toHex } from '@hashtree/core';
import { buildIsolatedSiteHref, isPortalShellHost } from '../src/lib/siteHost';
import { encodeImmutableHostLabel } from '../src/lib/siteIdentity';

describe('site host routing', () => {
  it('treats the bare sites host as the launcher shell', () => {
    expect(isPortalShellHost('sites.iris.to')).toBe(true);
    expect(isPortalShellHost('sites.hashtree.cc')).toBe(false);
    expect(isPortalShellHost('enshittifier.hashtree.cc')).toBe(false);
  });

  it('derives immutable runtime hosts from the keyless nhash so the server never sees the decrypt key', async () => {
    const nhash = 'nhash1qqsxyn0g6yyac8ruej7r7j80y2gx6ev5z5flu6ry5h5t3ajju5utzjs9yz7t3p2syr9n5heajlv85uwej232dk5x4zqe8d7ft67y3m5umxr55qjku38';
    const href = await buildIsolatedSiteHref({
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Isolated Site',
      nhash,
      entryPath: 'index.html',
    });

    const url = new URL(href);
    const decoded = nhashDecode(nhash);
    expect(url.hostname).toBe(`${encodeImmutableHostLabel(decoded.hash)}.hashtree.cc`);
    expect(url.pathname).toBe('/');
    expect(url.hash).toBe(`#/index.html?k=${toHex(decoded.key!)}`);
    expect(url.href).not.toContain(nhashEncode(decoded.hash));
    expect(url.href).not.toContain(nhash);
  });

  it('derives mutable runtime hosts from npub plus DNS-safe tree segments', async () => {
    const npub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const href = await buildIsolatedSiteHref({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'apps/iris',
      npub,
      treeName: 'apps/iris',
      entryPath: 'index.html',
    });

    expect(href).toBe(`https://${npub}.apps.iris.hashtree.cc/#/index.html`);
  });

  it('encodes non-DNS-safe mutable tree names into reversible host labels', async () => {
    const href = await buildIsolatedSiteHref({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'unsafe',
      npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      treeName: 'apps/iris ui',
      entryPath: 'index.html',
    });

    expect(href).toBe('https://npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq.x-617070732f69726973207569.hashtree.cc/#/index.html');
  });
});
