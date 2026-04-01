export interface BoardRouteIdentity {
  npub?: string | null;
  treeName?: string | null;
  path?: string[];
}

export type HydratedBoardResult = 'ready' | 'retry' | 'missing';

export function getBoardRouteKey(route: BoardRouteIdentity): string {
  return `${route.npub ?? ''}/${route.treeName ?? ''}/${(route.path ?? []).join('/')}`;
}

export function shouldShowBoardLoading(
  previousRouteKey: string | null,
  nextRouteKey: string,
  hasBoard: boolean
): boolean {
  if (!hasBoard) return true;
  return previousRouteKey !== nextRouteKey;
}

export function shouldApplyHydratedBoardState(
  previousRouteKey: string | null,
  nextRouteKey: string,
  currentUpdatedAt: number | null | undefined,
  hydratedUpdatedAt: number | null | undefined
): boolean {
  if (previousRouteKey !== nextRouteKey) return true;
  if (!currentUpdatedAt || !hydratedUpdatedAt) return true;
  return hydratedUpdatedAt >= currentUpdatedAt;
}

export function resolveHydratedBoardResult(options: {
  hasBoardSnapshot: boolean;
  hasIncompleteData: boolean;
  hasPendingData?: boolean;
}): HydratedBoardResult {
  if (options.hasBoardSnapshot) return 'ready';
  return options.hasIncompleteData || !!options.hasPendingData ? 'retry' : 'missing';
}

export function shouldScheduleHydratedBoardRetry(options: {
  hasIncompleteData: boolean;
  hasPendingData: boolean;
}): boolean {
  return options.hasIncompleteData || options.hasPendingData;
}
