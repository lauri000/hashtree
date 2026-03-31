<script lang="ts">
  /**
   * VideoRouter - Router for the video app
   * Routes:
   * - / : Home (recent videos, followed users' videos)
   * - /settings : Settings page
   * - /users : User list (switch user)
   * - /:nhash : Permalink to video (content-addressed)
   * - /:npub/edit : Edit profile page
   * - /:npub/profile : Profile page (alias)
   * - /:npub/follows : Following list
   * - /:npub/followers : Followers list
   * - /:npub/:treeName : Video view
   * - /:npub : Profile with videos (channel)
   */
  import { matchRoute } from '../../lib/router.svelte';
  import { isNHash } from '@hashtree/core';
  import VideoHome from './VideoHome.svelte';
  import VideoProfileView from './VideoProfileView.svelte';
  import VideoView from './VideoView.svelte';
  import VideoNHashView from './VideoNHashView.svelte';
  import VideoCreate from './VideoCreate.svelte';
  import SettingsLayout from '../settings/SettingsLayout.svelte';
  import WalletPage from '../WalletPage.svelte';
  import EditProfilePage from '../EditProfilePage.svelte';
  import UsersPage from '../UsersPage.svelte';
  import FollowsPage from '../FollowsPage.svelte';
  import FollowersPage from '../FollowersPage.svelte';

  const routePatterns = [
    { pattern: '/', component: VideoHome },
    { pattern: '/create', component: VideoCreate },
    { pattern: '/settings', component: SettingsLayout },
    { pattern: '/settings/*', component: SettingsLayout },
    { pattern: '/wallet', component: WalletPage },
    { pattern: '/users', component: UsersPage },
    { pattern: '/:npub/edit', component: EditProfilePage },
    { pattern: '/:npub/profile', component: VideoProfileView },
    { pattern: '/:npub/follows', component: FollowsPage },
    { pattern: '/:npub/followers', component: FollowersPage },
    // Video routes use :treeName param to support encoded slashes in tree names
    // e.g., "videos/My Playlist" becomes "videos%2FMy%20Playlist" in URL
    { pattern: '/:npub/:treeName/*', component: VideoView },
    { pattern: '/:npub/:treeName', component: VideoView },
    { pattern: '/:npub', component: VideoProfileView },
  ];

  interface Props {
    currentPath: string;
  }

  type GenericVideoRouteMatch = {
    kind: 'generic';
    component:
      | typeof VideoHome
      | typeof VideoCreate
      | typeof SettingsLayout
      | typeof WalletPage
      | typeof UsersPage
      | typeof EditProfilePage
      | typeof VideoProfileView
      | typeof FollowsPage
      | typeof FollowersPage
      | typeof VideoView;
    params: Record<string, string>;
  };

  type SnapshotVideoRouteMatch = {
    kind: 'nhash';
    params: {
      nhash: string;
      wild: string;
    };
  };

  let { currentPath }: Props = $props();

  // Match route
  let matchedRoute = $derived.by<GenericVideoRouteMatch | SnapshotVideoRouteMatch>(() => {
    // Check for nhash first (content-addressed permalink)
    const parts = currentPath.split('/').filter(Boolean);
    if (parts[0] && isNHash(parts[0])) {
      return {
        kind: 'nhash',
        params: {
          nhash: parts[0],
          wild: parts.slice(1).join('/'),
        },
      };
    }

    for (const route of routePatterns) {
      const match = matchRoute(route.pattern, currentPath);
      if (match.matched) {
        return { kind: 'generic', component: route.component, params: match.params };
      }
    }
    return { kind: 'generic', component: VideoHome, params: {} };
  });

</script>

{#key currentPath}
  {#if matchedRoute.kind === 'nhash'}
    <VideoNHashView {...matchedRoute.params} />
  {:else}
    <matchedRoute.component {...matchedRoute.params} />
  {/if}
{/key}
