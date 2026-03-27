<script lang="ts">
  import { nip19 } from 'nostr-tools';
  import { nostrStore } from '../../nostr';
  import { createProfileStore } from '../../stores/profile';
  import { createFollowsStore, followPubkey, unfollowPubkey } from '../../stores/follows';
  import { createTreesStore, type TreeEntry } from '../../stores';
  import { createFavoriteReposStore } from '../../stores';
  import { open as openCreateModal } from '../Modals/CreateModal.svelte';
  import { Avatar, Name, Badge, FollowedBy } from '../User';
  import CopyText from '../CopyText.svelte';
  import ProxyImg from '../ProxyImg.svelte';
  import ShareButton from '../ShareButton.svelte';
  import RepoCard from './RepoCard.svelte';
  import { buildGitHomeRepos } from './homeModel';
  import { filterOwnedFavoriteRepos, type FavoriteRepoRef } from '../../lib/gitFavorites';
  import { getFollowsMe, getFollowers, fetchUserFollows, fetchUserFollowers, socialGraphStore } from '../../utils/socialGraph';

  interface Props {
    npub: string;
  }

  let { npub }: Props = $props();

  let myPubkey = $derived($nostrStore.pubkey);
  let myNpub = $derived($nostrStore.npub);
  let isLoggedIn = $derived($nostrStore.isLoggedIn);

  let pubkeyHex = $derived.by(() => {
    try {
      const decoded = nip19.decode(npub);
      return decoded.data as string;
    } catch {
      return '';
    }
  });

  let isOwnProfile = $derived(myPubkey === pubkeyHex);

  let profileStore = $derived(createProfileStore(npub));
  let profile = $state<{
    name?: string;
    display_name?: string;
    about?: string;
    banner?: string;
    picture?: string;
    nip05?: string;
    website?: string;
  } | null>(null);

  $effect(() => {
    const store = profileStore;
    const unsub = store.subscribe(value => {
      profile = value;
    });
    return unsub;
  });

  let myFollowsStore = $derived(myPubkey ? createFollowsStore(myPubkey) : null);
  let myFollows = $state<string[]>([]);

  $effect(() => {
    if (!myFollowsStore) {
      myFollows = [];
      return;
    }
    const unsub = myFollowsStore.subscribe(value => {
      myFollows = value?.follows || [];
    });
    return () => {
      unsub();
      myFollowsStore?.destroy();
    };
  });

  let profileFollowsStore = $derived(pubkeyHex ? createFollowsStore(pubkeyHex) : null);
  let profileFollows = $state<string[]>([]);

  $effect(() => {
    if (!profileFollowsStore) {
      profileFollows = [];
      return;
    }
    const unsub = profileFollowsStore.subscribe(value => {
      profileFollows = value?.follows || [];
    });
    return () => {
      unsub();
      profileFollowsStore?.destroy();
    };
  });

  let graphVersion = $derived($socialGraphStore.version);

  let isFollowing = $derived.by(() => {
    graphVersion;
    return myFollows.includes(pubkeyHex);
  });

  let followsMe = $derived.by(() => {
    graphVersion;
    return getFollowsMe(pubkeyHex);
  });

  let knownFollowers = $derived.by(() => {
    graphVersion;
    return getFollowers(pubkeyHex);
  });

  $effect(() => {
    if (pubkeyHex) {
      fetchUserFollows(pubkeyHex);
      fetchUserFollowers(pubkeyHex);
    }
  });

  let treesStore = $derived(createTreesStore(npub));
  let trees = $state<TreeEntry[]>([]);

  $effect(() => {
    const store = treesStore;
    const unsub = store.subscribe(value => {
      trees = value;
    });
    return unsub;
  });

  let repos = $derived(buildGitHomeRepos(trees));

  let favoriteReposStore = $derived(pubkeyHex ? createFavoriteReposStore(pubkeyHex) : null);
  let favoriteRepos = $state<FavoriteRepoRef[]>([]);

  $effect(() => {
    if (!favoriteReposStore) {
      favoriteRepos = [];
      return;
    }

    const unsub = favoriteReposStore.subscribe(value => {
      favoriteRepos = value?.repos || [];
    });

    return () => {
      unsub();
      favoriteReposStore?.destroy();
    };
  });

  let visibleFavoriteRepos = $derived(
    npub ? filterOwnedFavoriteRepos(npub, repos.map(repo => repo.name), favoriteRepos) : [],
  );

  let bannerError = $state(false);
  let followLoading = $state(false);

  function navigate(path: string) {
    window.location.hash = path;
  }

  async function handleFollow() {
    followLoading = true;
    if (isFollowing) {
      await unfollowPubkey(pubkeyHex);
    } else {
      await followPubkey(pubkeyHex);
    }
    followLoading = false;
  }

  function createRepository() {
    if (!myNpub) {
      alert('Please sign in to create a repository');
      return;
    }
    openCreateModal('repository');
  }
</script>

<div class="flex-1 flex flex-col min-h-0 bg-surface-0 overflow-y-auto">
  <div class="h-32 md:h-40 bg-surface-2 relative shrink-0">
    {#if profile?.banner && !bannerError}
      <ProxyImg
        src={profile.banner}
        alt=""
        width={1200}
        height={320}
        class="w-full h-full object-cover"
        onerror={() => bannerError = true}
      />
    {/if}
  </div>

  <div class="px-4 pb-8 -mt-12 relative">
    <div class="mb-3">
      <Avatar pubkey={pubkeyHex} size={80} class="border-4 border-surface-0" />
    </div>

    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <h1 class="text-xl font-bold text-text-1 m-0 truncate">
          <Name pubkey={pubkeyHex} />
        </h1>
        {#if isOwnProfile}
          <span class="shrink-0 text-xs text-blue-500 flex items-center gap-1">
            <Badge pubKeyHex={pubkeyHex} size="sm" /> You
          </span>
        {:else if isFollowing}
          <span class="shrink-0 text-xs text-blue-500 flex items-center gap-1">
            <Badge pubKeyHex={pubkeyHex} size="sm" /> Following
          </span>
        {/if}
        {#if !isOwnProfile && followsMe}
          <span class="shrink-0 text-xs bg-surface-2 text-text-2 px-2 py-0.5 rounded">
            Follows you
          </span>
        {/if}
      </div>
      <div class="flex items-center gap-2 shrink-0">
        {#if isLoggedIn && isOwnProfile}
          <button
            onclick={() => navigate('/users')}
            class="btn-ghost"
            title="Switch user"
          >
            Switch User
          </button>
          <button
            onclick={() => navigate(`/${npub}/edit`)}
            class="btn-ghost"
          >
            Edit Profile
          </button>
        {/if}
        {#if isLoggedIn && !isOwnProfile}
          <button
            onclick={handleFollow}
            disabled={followLoading}
            class={isFollowing ? 'btn-ghost' : 'btn-success'}
          >
            {followLoading ? '...' : isFollowing ? 'Unfollow' : 'Follow'}
          </button>
        {/if}
        <ShareButton url={window.location.href} />
      </div>
    </div>

    <CopyText
      text={npub}
      displayText={npub.slice(0, 8) + '...' + npub.slice(-4)}
      class="text-sm mt-1"
      testId="copy-npub"
    />

    {#if profile?.nip05}
      <div class="text-sm text-accent mt-1">{profile.nip05}</div>
    {/if}

    {#if !isOwnProfile && pubkeyHex}
      <FollowedBy pubkey={pubkeyHex} class="mt-2" />
    {/if}

    {#if profile?.about}
      <p class="text-sm text-text-2 mt-3 whitespace-pre-wrap break-words">
        {profile.about}
      </p>
    {/if}

    <div class="flex gap-4 mt-4 text-sm">
      <a href="#/{npub}/follows" class="text-text-3 hover:text-text-1 no-underline">
        <span class="font-bold text-text-1">{profileFollows.length}</span> Following
      </a>
      <a href="#/{npub}/followers" class="text-text-3 hover:text-text-1 no-underline">
        <span class="font-bold text-text-1">{knownFollowers.size}</span> Known Followers
      </a>
    </div>

    {#if profile?.website}
      <a
        href={profile.website.startsWith('http') ? profile.website : `https://${profile.website}`}
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm text-accent mt-3 inline-block hover:underline"
      >
        {profile.website}
      </a>
    {/if}

    <div class="mt-8 flex items-center justify-between gap-3">
      <div>
        <div class="inline-flex items-center gap-2 rounded-full border border-surface-3 bg-surface-1 px-3 py-1 text-xs uppercase tracking-[0.22em] text-text-3">
          <span class="i-lucide-git-branch-plus text-sm"></span>
          Git Trees
        </div>
        <h2 class="mt-4 mb-2 text-3xl font-semibold text-text-1">Repositories</h2>
        <p class="m-0 max-w-2xl text-sm text-text-2">
          Published repositories tagged with <code>git</code> appear here.
        </p>
      </div>
    </div>

    <div class="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {#if isOwnProfile}
        <div
          onclick={createRepository}
          onkeydown={(event) => (event.key === 'Enter' || event.key === ' ') && createRepository()}
          class="rounded-2xl border border-dashed border-surface-3 bg-surface-1/70 p-5 min-h-44 flex flex-col justify-between cursor-pointer hover:border-accent hover:bg-surface-1 transition-colors"
          role="button"
          tabindex="0"
        >
          <div class="h-12 w-12 rounded-xl bg-accent/12 text-accent border border-accent/20 flex items-center justify-center">
            <span class="i-lucide-plus text-xl"></span>
          </div>
          <div class="space-y-2">
            <div class="text-[0.65rem] uppercase tracking-[0.24em] text-text-3">Create</div>
            <div class="text-lg font-semibold text-text-1">New Repository</div>
            <div class="text-sm text-text-2">Start a top-level git tree with an initial commit.</div>
          </div>
        </div>
      {/if}

      {#each repos as repo (repo.name)}
        {@const linkKeySuffix = repo.linkKey ? `?k=${repo.linkKey}` : ''}
        <RepoCard
          href="#/{npub}/{repo.name}{linkKeySuffix}"
          name={repo.name}
          visibility={repo.visibility}
          createdAt={repo.createdAt}
        />
      {/each}
    </div>

    {#if repos.length === 0}
      <div class="mt-8 rounded-2xl border border-surface-3 bg-surface-1/40 p-6 text-sm text-text-2">
        {#if isOwnProfile}
          No repositories yet. Create one here or push an existing repo with <code>git-remote-htree</code> so it gets a <code>git</code> label.
        {:else}
          No published repositories yet.
        {/if}
      </div>
    {/if}

    <div class="mt-10 flex items-center justify-between gap-3">
      <div>
        <div class="inline-flex items-center gap-2 rounded-full border border-surface-3 bg-surface-1 px-3 py-1 text-xs uppercase tracking-[0.22em] text-text-3">
          <span class="i-lucide-heart text-sm"></span>
          Likes
        </div>
        <h2 class="mt-4 mb-2 text-3xl font-semibold text-text-1">Liked Repositories</h2>
        <p class="m-0 max-w-2xl text-sm text-text-2">
          Public repositories this profile has liked from the git app.
        </p>
      </div>
    </div>

    {#if visibleFavoriteRepos.length > 0}
      <div class="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {#each visibleFavoriteRepos as repo (repo.address)}
          <RepoCard
            href={repo.href}
            name={repo.repoName}
            ownerPubkey={repo.ownerPubkey}
            metaLabel="Liked repository"
            accentIcon="heart"
          />
        {/each}
      </div>
    {:else}
      <div class="mt-8 rounded-2xl border border-surface-3 bg-surface-1/40 p-6 text-sm text-text-2">
        {#if isOwnProfile}
          Like a public repository and it will appear here.
        {:else}
          No liked repositories yet.
        {/if}
      </div>
    {/if}
  </div>
</div>
