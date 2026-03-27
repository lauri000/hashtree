import { describe, expect, it } from 'vitest';
import { nhashDecode, nhashEncode, toHex } from '@hashtree/core';
import { resolveHostedSite } from '../src/lib/siteConfig';
import { encodeImmutableHostLabel } from '../src/lib/siteIdentity';

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
      hash: '#/npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/apps%2Firis/index.html',
    });

    expect(site).toEqual({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'apps/iris',
      npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
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

  it('derives mutable runtime sites from readable npub and tree labels', () => {
    const site = resolveHostedSite({
      host: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq.apps.iris.hashtree.cc',
      hash: '#/index.html',
    });

    expect(site).toEqual({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'apps/iris',
      npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      treeName: 'apps/iris',
      entryPath: 'index.html',
    });
  });

  it('rejects mutable runtime fragments whose npub or tree do not match the hostname', () => {
    const site = resolveHostedSite({
      host: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq.apps.iris.hashtree.cc',
      hash: '#/npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq/other/index.html',
    });

    expect(site).toBeNull();
  });

  it('derives mutable runtime sites from encoded tree labels when needed', () => {
    const site = resolveHostedSite({
      host: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq.x-617070732f69726973207569.hashtree.cc',
      hash: '#/index.html',
    });

    expect(site).toEqual({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'apps/iris ui',
      npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      treeName: 'apps/iris ui',
      entryPath: 'index.html',
    });
  });
});
