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
