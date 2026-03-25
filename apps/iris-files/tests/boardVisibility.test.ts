import { describe, expect, it } from 'vitest';
import {
  buildBoardVisibilityQueryString,
  isProtectedBoardWithoutAccess,
  resolveBoardPublishLabels,
  resolveBoardVisibility,
  resolveBoardVisibilityLinkKey,
} from '../src/lib/boards/visibility';

describe('board visibility resolution', () => {
  it('falls back to cached route visibility when the trees list entry is missing', () => {
    expect(resolveBoardVisibility(undefined, 'link-visible')).toBe('link-visible');
  });

  it('prefers the trees list visibility when both are available', () => {
    expect(resolveBoardVisibility('private', 'link-visible')).toBe('private');
  });

  it('treats link-visible boards without a decryption key as protected even without a current tree entry', () => {
    expect(isProtectedBoardWithoutAccess(false, false, 'link-visible')).toBe(true);
    expect(isProtectedBoardWithoutAccess(false, false, 'private')).toBe(true);
    expect(isProtectedBoardWithoutAccess(false, false, undefined)).toBe(false);
  });

  it('always preserves the boards label when republishing board roots', () => {
    expect(resolveBoardPublishLabels(undefined)).toEqual(['boards']);
    expect(resolveBoardPublishLabels(['boards', 'team'])).toEqual(['boards', 'team']);
    expect(resolveBoardPublishLabels(['team', 'boards', 'team'])).toEqual(['team', 'boards']);
  });

  it('prefers the current route key before stored or generated link keys', () => {
    expect(
      resolveBoardVisibilityLinkKey('link-visible', 'route-key', 'stored-key', () => 'generated-key')
    ).toBe('route-key');
    expect(
      resolveBoardVisibilityLinkKey('link-visible', null, 'stored-key', () => 'generated-key')
    ).toBe('stored-key');
    expect(
      resolveBoardVisibilityLinkKey('link-visible', null, null, () => 'generated-key')
    ).toBe('generated-key');
    expect(
      resolveBoardVisibilityLinkKey('public', 'route-key', 'stored-key', () => 'generated-key')
    ).toBeUndefined();
  });

  it('adds or removes the link key query param based on visibility', () => {
    expect(
      buildBoardVisibilityQueryString(new URLSearchParams('view=compact'), 'link-visible', 'shared-key')
    ).toBe('view=compact&k=shared-key');
    expect(
      buildBoardVisibilityQueryString(new URLSearchParams('view=compact&k=stale'), 'private')
    ).toBe('view=compact');
  });
});
