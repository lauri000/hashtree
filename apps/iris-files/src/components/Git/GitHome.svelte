<script lang="ts">
  import { nostrStore } from '../../nostr';
  import { createTreesStore, type TreeEntry } from '../../stores';
  import { createFavoriteReposStore } from '../../stores';
  import { open as openCreateModal } from '../Modals/CreateModal.svelte';
  import RepoCard from './RepoCard.svelte';
  import { buildGitHomeRepos } from './homeModel';
  import { filterOwnedFavoriteRepos, type FavoriteRepoRef } from '../../lib/gitFavorites';

  let userNpub = $derived($nostrStore.npub);
  let isLoggedIn = $derived($nostrStore.isLoggedIn);

  let treesStore = $derived(createTreesStore(userNpub));
  let trees = $state<TreeEntry[]>([]);

  $effect(() => {
    const store = treesStore;
    const unsub = store.subscribe(value => {
      trees = value;
    });
    return unsub;
  });

  let repos = $derived(buildGitHomeRepos(trees));

  let favoriteReposStore = $derived(userNpub ? createFavoriteReposStore(userNpub) : null);
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
    userNpub ? filterOwnedFavoriteRepos(userNpub, repos.map(repo => repo.name), favoriteRepos) : [],
  );

  function createRepository() {
    if (!userNpub) {
      alert('Please sign in to create a repository');
      return;
    }
    openCreateModal('repository');
  }
</script>

<div class="flex-1 overflow-auto bg-surface-0">
  <div class="max-w-5xl mx-auto p-6 md:p-8">
    <div class="mb-6 md:mb-8">
      <div class="inline-flex items-center gap-2 rounded-full border border-surface-3 bg-surface-1 px-3 py-1 text-xs uppercase tracking-[0.22em] text-text-3">
        <span class="i-lucide-git-branch-plus text-sm"></span>
        Git Trees
      </div>
      <h1 class="mt-4 mb-2 text-3xl font-semibold text-text-1">Repositories</h1>
      <p class="m-0 max-w-2xl text-sm text-text-2">
        Published repositories tagged with <code>git</code> appear here. Public repositories you like are listed below.
      </p>
    </div>

    <section>
      <div class="mb-4">
        <h2 class="m-0 text-xl font-semibold text-text-1">{isLoggedIn ? 'Your Repositories' : 'Repositories'}</h2>
        <p class="m-0 mt-1 text-sm text-text-2">
          {#if isLoggedIn}
            Trees you publish with the <code>git</code> label appear here.
          {:else}
            Sign in to see and create your repositories.
          {/if}
        </p>
      </div>

      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {#if isLoggedIn}
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
            href="#/{userNpub}/{repo.name}{linkKeySuffix}"
            name={repo.name}
            visibility={repo.visibility}
            createdAt={repo.createdAt}
          />
        {/each}
      </div>

      {#if repos.length === 0}
        <div class="mt-8 rounded-2xl border border-surface-3 bg-surface-1/40 p-6 text-sm text-text-2">
          {#if isLoggedIn}
            No repositories yet. Create one here or push an existing repo with <code>git-remote-htree</code> so it gets a <code>git</code> label.
          {:else}
            Sign in to see and create your repositories.
          {/if}
        </div>
      {/if}
    </section>

    {#if isLoggedIn && visibleFavoriteRepos.length > 0}
      <section class="mt-10">
        <div class="mb-4">
          <div class="inline-flex items-center gap-2 rounded-full border border-surface-3 bg-surface-1 px-3 py-1 text-xs uppercase tracking-[0.22em] text-text-3">
            <span class="i-lucide-heart text-sm"></span>
            Likes
          </div>
          <h2 class="mt-4 mb-2 text-xl font-semibold text-text-1">Liked Repositories</h2>
          <p class="m-0 max-w-2xl text-sm text-text-2">
            Public repositories you like from the git app appear here.
          </p>
        </div>

        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
      </section>
    {/if}
  </div>
</div>
