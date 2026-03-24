<script lang="ts">
  import BoardsHome from './BoardsHome.svelte';
  import BoardView from './BoardView.svelte';
  import SettingsLayout from '../settings/SettingsLayout.svelte';
  import EditProfilePage from '../EditProfilePage.svelte';
  import UsersPage from '../UsersPage.svelte';
  import FollowsPage from '../FollowsPage.svelte';
  import FollowersPage from '../FollowersPage.svelte';
  import ProfileView from '../ProfileView.svelte';
  import { matchBoardsRoute } from './routes';

  interface Props {
    currentPath: string;
  }

  let { currentPath }: Props = $props();

  let matchedRoute = $derived.by(() => {
    const match = matchBoardsRoute(currentPath);
    const component = ({
      home: BoardsHome,
      settings: SettingsLayout,
      users: UsersPage,
      'edit-profile': EditProfilePage,
      follows: FollowsPage,
      followers: FollowersPage,
      profile: ProfileView,
      board: BoardView,
    } as const)[match.key];

    return { component, params: match.params };
  });
</script>

<matchedRoute.component {...matchedRoute.params} />
