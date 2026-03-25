export interface BoardRouteIdentity {
  npub?: string | null;
  treeName?: string | null;
  path?: string[];
}

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
