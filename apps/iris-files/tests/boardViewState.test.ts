import { describe, expect, it } from 'vitest';
import { getBoardRouteKey, shouldShowBoardLoading } from '../src/lib/boards/viewState';

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
});
