export interface PullRequestDiffData {
  diff: string;
  stats: {
    additions: number;
    deletions: number;
    files: string[];
  };
}

export interface PullRequestDiffLoadState {
  diffLoading: boolean;
  diffError: string | null;
  diffData: PullRequestDiffData | null;
}

export function nextPrDiffLoadGenerationForPrChange(
  previousPrId: string | null | undefined,
  nextPrId: string | null | undefined,
  currentGeneration: number
): number {
  return previousPrId === nextPrId ? currentGeneration : currentGeneration + 1;
}

export function isCurrentPrDiffLoadRequest(
  requestPrId: string | null | undefined,
  currentPrId: string | null | undefined,
  requestGeneration: number,
  currentGeneration: number
): boolean {
  return requestPrId === currentPrId && requestGeneration === currentGeneration;
}

export function resetPrDiffStateForPrChange(
  previousPrId: string | null | undefined,
  nextPrId: string | null | undefined,
  state: PullRequestDiffLoadState
): PullRequestDiffLoadState {
  if (previousPrId === nextPrId) {
    return state;
  }

  return {
    diffLoading: false,
    diffError: null,
    diffData: null,
  };
}
