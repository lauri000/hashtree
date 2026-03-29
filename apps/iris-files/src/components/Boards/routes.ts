import { matchRoute, type RouteParams } from '../../lib/router.svelte';

export type BoardsRouteKey =
  | 'home'
  | 'settings'
  | 'users'
  | 'edit-profile'
  | 'follows'
  | 'followers'
  | 'profile'
  | 'board';

interface BoardsRouteMatch {
  key: BoardsRouteKey;
  params: RouteParams;
}

const boardsRoutePatterns: Array<{ pattern: string; key: BoardsRouteKey }> = [
  { pattern: '/', key: 'home' },
  { pattern: '/settings', key: 'settings' },
  { pattern: '/settings/*', key: 'settings' },
  { pattern: '/users', key: 'users' },
  { pattern: '/:npub/edit', key: 'edit-profile' },
  { pattern: '/:npub/follows', key: 'follows' },
  { pattern: '/:npub/followers', key: 'followers' },
  { pattern: '/:npub/profile', key: 'profile' },
  { pattern: '/:npub/:treeName/*', key: 'board' },
  { pattern: '/:npub/:treeName', key: 'board' },
  { pattern: '/:npub', key: 'home' },
];

export function matchBoardsRoute(currentPath: string): BoardsRouteMatch {
  for (const route of boardsRoutePatterns) {
    const match = matchRoute(route.pattern, currentPath);
    if (match.matched) {
      return { key: route.key, params: match.params };
    }
  }

  return { key: 'home', params: {} };
}
