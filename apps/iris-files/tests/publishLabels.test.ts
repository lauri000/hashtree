import { describe, expect, it } from 'vitest';
import { resolvePublishLabels } from '../src/nostr/publishLabels';

describe('resolvePublishLabels', () => {
  it('preserves existing labels when callers omit them on republish', () => {
    expect(resolvePublishLabels({ currentLabels: ['git'] })).toEqual(['git']);
  });

  it('merges existing and explicit labels without duplicates', () => {
    expect(resolvePublishLabels({
      currentLabels: ['git'],
      explicitLabels: ['docs', 'git'],
    })).toEqual(['git', 'docs']);
  });

  it('adds the git label when repo detection requires it', () => {
    expect(resolvePublishLabels({ includeGitLabel: true })).toEqual(['git']);
  });

  it('returns undefined when no labels are available', () => {
    expect(resolvePublishLabels()).toBeUndefined();
  });
});
