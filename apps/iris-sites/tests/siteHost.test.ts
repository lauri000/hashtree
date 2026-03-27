import { describe, expect, it } from 'vitest';
import { nhashDecode, nhashEncode, toHex } from '@hashtree/core';
import { buildIsolatedSiteHref, buildLauncherHref, buildPermalinkHref, buildSourceHref, isPortalShellHost } from '../src/lib/siteHost';
import { encodeImmutableHostLabel, encodeMutableHostLabel } from '../src/lib/siteIdentity';

const VALID_NPUB = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';

describe('site host routing', () => {
  it('treats the bare sites host as the launcher shell', () => {
    expect(isPortalShellHost('sites.iris.to')).toBe(true);
    expect(isPortalShellHost('sites.hashtree.cc')).toBe(false);
    expect(isPortalShellHost('enshittifier.hashtree.cc')).toBe(false);
  });

  it('derives mutable runtime hosts from an opaque hash label', () => {
    const label = encodeMutableHostLabel(VALID_NPUB, 'enshittifier');

    expect(label).toMatch(/^[a-z2-7]{52}$/);
    expect(label).not.toContain('npub1');
    expect(label).not.toContain('enshittifier');
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

  it('builds launcher URLs on sites.iris.to from runtime hosts', () => {
    expect(buildLauncherHref({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'Midi',
      npub: VALID_NPUB,
      treeName: 'enshittifier',
      entryPath: 'index.html',
    })).toBe(`https://sites.iris.to/#/${VALID_NPUB}/enshittifier/index.html`);
  });

  it('builds source URLs on files.iris.to for the same hosted route', () => {
    expect(buildSourceHref({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'Midi',
      npub: VALID_NPUB,
      treeName: 'enshittifier',
      entryPath: 'index.html',
    })).toBe(`https://files.iris.to/#/${VALID_NPUB}/enshittifier/index.html`);
  });

  it('derives mutable permalinks from the currently resolved tree root nhash', () => {
    const currentVersion = nhashDecode('nhash1qqsxyn0g6yyac8ruej7r7j80y2gx6ev5z5flu6ry5h5t3ajju5utzjs9yz7t3p2syr9n5heajlv85uwej232dk5x4zqe8d7ft67y3m5umxr55qjku38');

    expect(buildPermalinkHref({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'Midi',
      npub: VALID_NPUB,
      treeName: 'enshittifier',
      entryPath: 'index.html',
    }, {
      hash: currentVersion.hash,
      key: currentVersion.key,
    })).toBe(
      'https://sites.iris.to/#/nhash1qqsxyn0g6yyac8ruej7r7j80y2gx6ev5z5flu6ry5h5t3ajju5utzjs9yz7t3p2syr9n5heajlv85uwej232dk5x4zqe8d7ft67y3m5umxr55qjku38/index.html',
    );
  });

  it('does not invent mutable permalinks before the current tree root is known', () => {
    expect(buildPermalinkHref({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'Midi',
      npub: VALID_NPUB,
      treeName: 'enshittifier',
      entryPath: 'index.html',
    })).toBeNull();
  });

  it('builds local launcher URLs from local runtime hosts', () => {
    expect(buildLauncherHref({
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Pinned',
      nhash: 'nhash1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      entryPath: 'index.html',
    }, '63dvmlmvh6sxd65q7abane2j23fl4e7hmub4lwdjvl6vwmzlobda.sites.iris.localhost:5178')).toBe(
      'http://sites.iris.localhost:5178/#/nhash1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/index.html',
    );
  });

  it('builds local source URLs against the local iris-files app', () => {
    expect(buildSourceHref({
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Pinned',
      nhash: 'nhash1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      entryPath: 'index.html',
    }, '63dvmlmvh6sxd65q7abane2j23fl4e7hmub4lwdjvl6vwmzlobda.sites.iris.localhost:5178')).toBe(
      'http://localhost:5173/#/nhash1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/index.html',
    );
  });

  it('derives mutable runtime hosts into a single owner-tree label', async () => {
    const href = await buildIsolatedSiteHref({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'apps/iris',
      npub: VALID_NPUB,
      treeName: 'apps/iris',
      entryPath: 'index.html',
    });

    expect(href).toBe(`https://${encodeMutableHostLabel(VALID_NPUB, 'apps/iris')}.hashtree.cc/#/${VALID_NPUB}/apps%2Firis/index.html`);
  });

  it('keeps non-DNS-safe mutable tree names in the fragment while the host stays single-label', async () => {
    const href = await buildIsolatedSiteHref({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'unsafe',
      npub: VALID_NPUB,
      treeName: 'apps/iris ui',
      entryPath: 'index.html',
    });

    expect(href).toBe(`https://${encodeMutableHostLabel(VALID_NPUB, 'apps/iris ui')}.hashtree.cc/#/${VALID_NPUB}/apps%2Firis%20ui/index.html`);
  });
});
