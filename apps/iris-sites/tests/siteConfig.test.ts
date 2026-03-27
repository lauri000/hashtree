import { describe, expect, it } from 'vitest';
import { resolveHostedSite } from '../src/lib/siteConfig';

describe('site config resolution', () => {
  it('does not special-case a pretty pilot alias host', () => {
    const site = resolveHostedSite({
      host: 'enshittifier.hashtree.cc',
      hash: '',
    });

    expect(site).toBeNull();
  });

  it('supports generic immutable roots through the hash fragment so the server only sees the boot page request', () => {
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

  it('supports mutable sites through the hash fragment without exposing npub or tree name to the server', () => {
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
});
