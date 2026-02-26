import { describe, expect, it } from 'vitest';
import {
  isCurrentPrDiffLoadRequest,
  nextPrDiffLoadGenerationForPrChange,
  resetPrDiffStateForPrChange,
  type PullRequestDiffLoadState,
} from '../src/components/Git/prDiffLoadState';

function sampleState(): PullRequestDiffLoadState {
  return {
    diffLoading: true,
    diffError: 'Timed out',
    diffData: {
      diff: 'diff --git a/a b/a',
      stats: { additions: 1, deletions: 0, files: ['a'] },
    },
  };
}

describe('resetPrDiffStateForPrChange', () => {
  it('clears failed diff state when navigating to a different PR', () => {
    const result = resetPrDiffStateForPrChange('pr-a', 'pr-b', sampleState());

    expect(result).toEqual({
      diffLoading: false,
      diffError: null,
      diffData: null,
    });
  });

  it('preserves diff state when staying on the same PR', () => {
    const state = sampleState();
    const result = resetPrDiffStateForPrChange('pr-a', 'pr-a', state);

    expect(result).toBe(state);
  });

  it('starts with cleared state for the first PR identity assignment', () => {
    const result = resetPrDiffStateForPrChange(null, 'pr-a', sampleState());

    expect(result).toEqual({
      diffLoading: false,
      diffError: null,
      diffData: null,
    });
  });
});

describe('nextPrDiffLoadGenerationForPrChange', () => {
  it('increments generation when navigating to a different PR', () => {
    expect(nextPrDiffLoadGenerationForPrChange('pr-a', 'pr-b', 5)).toBe(6);
  });

  it('does not increment generation when staying on the same PR', () => {
    expect(nextPrDiffLoadGenerationForPrChange('pr-a', 'pr-a', 5)).toBe(5);
  });
});

describe('isCurrentPrDiffLoadRequest', () => {
  it('returns true when PR id and generation match', () => {
    expect(isCurrentPrDiffLoadRequest('pr-a', 'pr-a', 3, 3)).toBe(true);
  });

  it('returns false when PR id differs', () => {
    expect(isCurrentPrDiffLoadRequest('pr-a', 'pr-b', 3, 3)).toBe(false);
  });

  it('returns false when generation differs even if PR id matches', () => {
    expect(isCurrentPrDiffLoadRequest('pr-a', 'pr-a', 3, 4)).toBe(false);
  });
});
