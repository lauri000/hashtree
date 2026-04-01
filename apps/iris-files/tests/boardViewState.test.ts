import { describe, expect, it } from 'vitest';
import {
  getBoardRouteKey,
  resolveHydratedBoardResult,
  shouldScheduleHydratedBoardRetry,
  shouldApplyHydratedBoardState,
  shouldShowBoardLoading,
} from '../src/lib/boards/viewState';

describe('board view loading state', () => {
  it('does not re-enter loading for root-only updates on the same board route', () => {
    const routeKey = getBoardRouteKey({
      npub: 'npub1owner',
      treeName: 'boards/roadmap',
      path: ['backlog'],
    });

    expect(shouldShowBoardLoading(routeKey, routeKey, true)).toBe(false);
  });

  it('shows loading when navigating to a different board route', () => {
    const previousKey = getBoardRouteKey({
      npub: 'npub1owner',
      treeName: 'boards/roadmap',
      path: ['backlog'],
    });
    const nextKey = getBoardRouteKey({
      npub: 'npub1owner',
      treeName: 'boards/roadmap',
      path: ['done'],
    });

    expect(shouldShowBoardLoading(previousKey, nextKey, true)).toBe(true);
  });

  it('shows loading until the board has been hydrated for the current route', () => {
    const routeKey = getBoardRouteKey({
      npub: 'npub1owner',
      treeName: 'boards/roadmap',
      path: [],
    });

    expect(shouldShowBoardLoading(routeKey, routeKey, false)).toBe(true);
  });

  it('keeps newer local board state when the same route hydrates an older snapshot', () => {
    const routeKey = getBoardRouteKey({
      npub: 'npub1owner',
      treeName: 'boards/roadmap',
      path: ['backlog'],
    });

    expect(shouldApplyHydratedBoardState(routeKey, routeKey, 200, 150)).toBe(false);
    expect(shouldApplyHydratedBoardState(routeKey, routeKey, 200, 200)).toBe(true);
    expect(shouldApplyHydratedBoardState(routeKey, routeKey, 200, 250)).toBe(true);
  });

  it('always accepts hydrated state after navigating to a different route', () => {
    const previousKey = getBoardRouteKey({
      npub: 'npub1owner',
      treeName: 'boards/roadmap',
      path: ['backlog'],
    });
    const nextKey = getBoardRouteKey({
      npub: 'npub1owner',
      treeName: 'boards/roadmap',
      path: ['done'],
    });

    expect(shouldApplyHydratedBoardState(previousKey, nextKey, 500, 100)).toBe(true);
  });

  it('keeps retrying when permissions load before the board snapshot', () => {
    expect(resolveHydratedBoardResult({
      hasBoardSnapshot: false,
      hasIncompleteData: true,
      hasPendingData: false,
    })).toBe('retry');
  });

  it('keeps retrying when collaborator roots are still pending', () => {
    expect(resolveHydratedBoardResult({
      hasBoardSnapshot: false,
      hasIncompleteData: false,
      hasPendingData: true,
    })).toBe('retry');
  });

  it('treats permissions-only hydration without missing reads as an error', () => {
    expect(resolveHydratedBoardResult({
      hasBoardSnapshot: false,
      hasIncompleteData: false,
      hasPendingData: false,
    })).toBe('missing');
  });

  it('uses the hydrated board when a snapshot exists', () => {
    expect(resolveHydratedBoardResult({
      hasBoardSnapshot: true,
      hasIncompleteData: true,
      hasPendingData: true,
    })).toBe('ready');
  });

  it('schedules a background retry when collaborator data is still pending', () => {
    expect(shouldScheduleHydratedBoardRetry({
      hasIncompleteData: false,
      hasPendingData: true,
    })).toBe(true);
  });

  it('stops retrying once hydration is complete', () => {
    expect(shouldScheduleHydratedBoardRetry({
      hasIncompleteData: false,
      hasPendingData: false,
    })).toBe(false);
  });
});
