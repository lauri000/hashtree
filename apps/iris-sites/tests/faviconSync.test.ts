import { describe, expect, it } from 'vitest';
import { extractSafeFaviconLinks } from '../src/lib/faviconSync';

describe('favicon sync helpers', () => {
  it('only accepts same-origin /htree favicon links', () => {
    const safe = extractSafeFaviconLinks(
      [
        { rel: 'icon', href: './favicon.svg' },
        { rel: 'shortcut icon', href: '/htree/npub1demo/site/favicon.ico' },
      ],
      'https://abc.hashtree.cc/htree/npub1demo/site/index.html',
      'https://abc.hashtree.cc',
    );

    expect(safe).toEqual([
      {
        rel: 'icon',
        href: 'https://abc.hashtree.cc/htree/npub1demo/site/favicon.svg',
      },
      {
        rel: 'shortcut icon',
        href: 'https://abc.hashtree.cc/htree/npub1demo/site/favicon.ico',
      },
    ]);
  });

  it('rejects injected or shell-level favicon URLs', () => {
    const safe = extractSafeFaviconLinks(
      [
        { rel: 'icon', href: 'javascript:alert(1)' },
        { rel: 'icon', href: 'data:image/svg+xml,<svg></svg>' },
        { rel: 'icon', href: 'blob:https://abc.hashtree.cc/123' },
        { rel: 'icon', href: 'https://evil.example/icon.png' },
        { rel: 'icon', href: '/favicon.svg' },
      ],
      'https://abc.hashtree.cc/htree/npub1demo/site/index.html',
      'https://abc.hashtree.cc',
    );

    expect(safe).toEqual([]);
  });

  it('deduplicates accepted links by rel and href', () => {
    const safe = extractSafeFaviconLinks(
      [
        { rel: 'icon', href: './favicon.svg' },
        { rel: 'icon', href: './favicon.svg' },
        { rel: 'shortcut icon', href: './favicon.svg' },
      ],
      'https://abc.hashtree.cc/htree/npub1demo/site/index.html',
      'https://abc.hashtree.cc',
    );

    expect(safe).toEqual([
      {
        rel: 'icon',
        href: 'https://abc.hashtree.cc/htree/npub1demo/site/favicon.svg',
      },
      {
        rel: 'shortcut icon',
        href: 'https://abc.hashtree.cc/htree/npub1demo/site/favicon.svg',
      },
    ]);
  });
});
