import { describe, it, expect } from 'vitest';
import { buildHtreeUrl, parseHtreeUrl } from '../src/index.js';

const KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('htree url helpers', () => {
  it('parses public urls', () => {
    const parsed = parseHtreeUrl('htree://npub1deadbeef/repo');
    expect(parsed.identifier).toBe('npub1deadbeef');
    expect(parsed.repo).toBe('repo');
    expect(parsed.visibility).toBe('public');
    expect(parsed.linkKey).toBeUndefined();
    expect(parsed.autoGenerateLinkKey).toBe(false);
  });

  it('parses private urls', () => {
    const parsed = parseHtreeUrl('htree://self/repo#private');
    expect(parsed.visibility).toBe('private');
    expect(parsed.linkKey).toBeUndefined();
    expect(parsed.autoGenerateLinkKey).toBe(false);
  });

  it('parses link-visible urls', () => {
    const parsed = parseHtreeUrl('htree://npub1deadbeef/repo#link-visible');
    expect(parsed.visibility).toBe('link-visible');
    expect(parsed.linkKey).toBeUndefined();
    expect(parsed.autoGenerateLinkKey).toBe(true);
  });

  it('parses link-visible urls with key', () => {
    const parsed = parseHtreeUrl(`htree://npub1deadbeef/repo#k=${KEY_HEX.toUpperCase()}`);
    expect(parsed.visibility).toBe('link-visible');
    expect(parsed.linkKey).toBe(KEY_HEX);
    expect(parsed.autoGenerateLinkKey).toBe(false);
  });

  it('throws for invalid url', () => {
    expect(() => parseHtreeUrl('nostr://npub1deadbeef/repo')).toThrow();
    expect(() => parseHtreeUrl('htree://npub1deadbeef')).toThrow();
    expect(() => parseHtreeUrl('htree://npub1deadbeef/repo#k=bad')).toThrow();
  });

  it('builds urls', () => {
    expect(buildHtreeUrl('npub1deadbeef', 'repo')).toBe('htree://npub1deadbeef/repo');
    expect(buildHtreeUrl('npub1deadbeef', 'repo', { visibility: 'private' })).toBe('htree://npub1deadbeef/repo#private');
    expect(buildHtreeUrl('npub1deadbeef', 'repo', { visibility: 'link-visible', autoGenerateLinkKey: true })).toBe('htree://npub1deadbeef/repo#link-visible');
    expect(buildHtreeUrl('npub1deadbeef', 'repo', { visibility: 'link-visible', linkKey: KEY_HEX })).toBe(`htree://npub1deadbeef/repo#k=${KEY_HEX}`);
  });

  it('rejects invalid key when building', () => {
    expect(() => buildHtreeUrl('npub1deadbeef', 'repo', { visibility: 'link-visible', linkKey: 'bad' })).toThrow();
  });
});
