<script lang="ts">
  import { matchRoute } from '../../lib/router.svelte';
  import BoardsHome from './BoardsHome.svelte';
  import BoardView from './BoardView.svelte';
  import SettingsLayout from '../settings/SettingsLayout.svelte';
  import EditProfilePage from '../EditProfilePage.svelte';
  import UsersPage from '../UsersPage.svelte';
  import FollowsPage from '../FollowsPage.svelte';
  import FollowersPage from '../FollowersPage.svelte';

  const routePatterns = [
    { pattern: '/', component: BoardsHome },
    { pattern: '/settings', component: SettingsLayout },
    { pattern: '/settings/:tab', component: SettingsLayout },
    { pattern: '/users', component: UsersPage },
    { pattern: '/:npub/edit', component: EditProfilePage },
    { pattern: '/:npub/follows', component: FollowsPage },
    { pattern: '/:npub/followers', component: FollowersPage },
    { pattern: '/:npub/:treeName/*', component: BoardView },
    { pattern: '/:npub/:treeName', component: BoardView },
    { pattern: '/:npub', component: BoardsHome },
  ];

  interface Props {
    currentPath: string;
  }

  let { currentPath }: Props = $props();

  let matchedRoute = $derived.by(() => {
    for (const route of routePatterns) {
      const match = matchRoute(route.pattern, currentPath);
      if (match.matched) {
        return { component: route.component, params: match.params };
      }
    }
    return { component: BoardsHome, params: {} };
  });
</script>

<matchedRoute.component {...matchedRoute.params} />
