import { describe, expect, it } from 'vitest';
import { nhashDecode, nhashEncode, toHex } from '@hashtree/core';
import { resolveHostedSite } from '../src/lib/siteConfig';
import { encodeImmutableHostLabel, encodeMutableHostLabel } from '../src/lib/siteIdentity';

const VALID_NPUB = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';

describe('site config resolution', () => {
  it('does not special-case a pretty pilot alias host', () => {
    const site = resolveHostedSite({
      host: 'enshittifier.hashtree.cc',
      hash: '',
    });

    expect(site).toBeNull();
  });

  it('supports generic immutable roots through the launcher hash fragment', () => {
    const site = resolveHostedSite({
      host: 'sites.iris.to',
      hash: '#/nhash1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/index.html',
    });

    expect(site).toEqual({
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Isolated Site',
      nhash: 'nhash1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      entryPath: 'index.html',
    });
  });

  it('supports mutable sites through the launcher hash fragment without exposing npub or tree name to the server', () => {
    const site = resolveHostedSite({
      host: 'sites.iris.to',
      hash: `#/${VALID_NPUB}/apps%2Firis/index.html`,
    });

    expect(site).toEqual({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'apps/iris',
      npub: VALID_NPUB,
      treeName: 'apps/iris',
      entryPath: 'index.html',
    });
  });

  it('accepts the explicit hash namespace form for mutable routes', () => {
    const site = resolveHostedSite({
      host: 'sites.iris.to',
      hash: '#/npub/npub1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/public/index.html',
    });

    expect(site).toEqual({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'public',
      npub: 'npub1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      treeName: 'public',
      entryPath: 'index.html',
    });
  });

  it('derives immutable runtime sites from a keyless nhash host plus a fragment key', () => {
    const fullNhash = 'nhash1qqsxyn0g6yyac8ruej7r7j80y2gx6ev5z5flu6ry5h5t3ajju5utzjs9yz7t3p2syr9n5heajlv85uwej232dk5x4zqe8d7ft67y3m5umxr55qjku38';
    const decoded = nhashDecode(fullNhash);

    const site = resolveHostedSite({
      host: `${encodeImmutableHostLabel(decoded.hash)}.hashtree.cc`,
      hash: `#/index.html?k=${toHex(decoded.key!)}`,
    });

    expect(site).toEqual({
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Isolated Site',
      nhash: fullNhash,
      entryPath: 'index.html',
    });
  });

  it('rejects immutable runtime fragments whose nhash does not match the hostname hash', () => {
    const fullNhash = 'nhash1qqsxyn0g6yyac8ruej7r7j80y2gx6ev5z5flu6ry5h5t3ajju5utzjs9yz7t3p2syr9n5heajlv85uwej232dk5x4zqe8d7ft67y3m5umxr55qjku38';
    const decoded = nhashDecode(fullNhash);
    const otherHash = new Uint8Array(decoded.hash);
    otherHash[0] ^= 1;

    const site = resolveHostedSite({
      host: `${encodeImmutableHostLabel(decoded.hash)}.hashtree.cc`,
      hash: `#/${nhashEncode(otherHash)}/index.html`,
    });

    expect(site).toBeNull();
  });

  it('derives mutable runtime sites from a single-label owner-tree host plus the full fragment route', () => {
    const site = resolveHostedSite({
      host: `${encodeMutableHostLabel(VALID_NPUB, 'apps/iris')}.hashtree.cc`,
      hash: `#/${VALID_NPUB}/apps%2Firis/index.html`,
    });

    expect(site).toEqual({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'apps/iris',
      npub: VALID_NPUB,
      treeName: 'apps/iris',
      entryPath: 'index.html',
    });
  });

  it('rejects mutable runtime fragments whose npub or tree do not match the hostname', () => {
    const site = resolveHostedSite({
      host: `${encodeMutableHostLabel(VALID_NPUB, 'apps/iris')}.hashtree.cc`,
      hash: `#/${VALID_NPUB}/other/index.html`,
    });

    expect(site).toBeNull();
  });

  it('accepts mutable runtime hosts for tree names that are only present in the fragment', () => {
    const site = resolveHostedSite({
      host: `${encodeMutableHostLabel(VALID_NPUB, 'apps/iris ui')}.hashtree.cc`,
      hash: `#/${VALID_NPUB}/apps%2Firis%20ui/index.html`,
    });

    expect(site).toEqual({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'apps/iris ui',
      npub: VALID_NPUB,
      treeName: 'apps/iris ui',
      entryPath: 'index.html',
    });
  });

  it('does not treat old readable mutable hosts as valid runtimes', () => {
    const site = resolveHostedSite({
      host: 'npub1xdhnr9mrv47-enshittifier-63dvmlmvh6sxd65q7aba.hashtree.cc',
      hash: `#/${VALID_NPUB}/enshittifier/index.html`,
    });

    expect(site).toBeNull();
  });
});
