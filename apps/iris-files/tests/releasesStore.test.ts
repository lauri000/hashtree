import { describe, expect, it } from 'vitest';
import { buildReleaseTreeName, isListedReleaseEntryName, sanitizeReleaseId } from '../src/stores/releaseHelpers';

describe('releases store helpers', () => {
  it('builds the repo release tree name under releases/<repo>', () => {
    expect(buildReleaseTreeName('nostr-vpn')).toBe('releases/nostr-vpn');
    expect(buildReleaseTreeName('/nostr-vpn/')).toBe('releases/nostr-vpn');
  });

  it('sanitizes release ids for tree entries', () => {
    expect(sanitizeReleaseId(' v0.2.27 beta / 1 ')).toBe('v0.2.27-beta-1');
  });

  it('hides the synthetic latest pointer from release listings', () => {
    expect(isListedReleaseEntryName('v0.2.27')).toBe(true);
    expect(isListedReleaseEntryName('latest')).toBe(false);
  });
});
