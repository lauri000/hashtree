import { describe, expect, it } from 'vitest';
import { buildReleaseTreeName, isListedReleaseEntryName, sanitizeReleaseId } from '../src/stores/releaseHelpers';

describe('releases store helpers', () => {
  it('builds the nested release tree name for a repo', () => {
    expect(buildReleaseTreeName('nostr-vpn')).toBe('nostr-vpn/releases');
    expect(buildReleaseTreeName('/nostr-vpn/')).toBe('nostr-vpn/releases');
  });

  it('sanitizes release ids for tree entries', () => {
    expect(sanitizeReleaseId(' v0.2.27 beta / 1 ')).toBe('v0.2.27-beta-1');
  });

  it('hides the synthetic latest pointer from release listings', () => {
    expect(isListedReleaseEntryName('v0.2.27')).toBe(true);
    expect(isListedReleaseEntryName('latest')).toBe(false);
  });
});
