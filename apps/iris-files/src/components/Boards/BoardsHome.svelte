<script lang="ts">
  import { nip19 } from 'nostr-tools';
  import { SvelteSet } from 'svelte/reactivity';
  import { createBoardTree } from '../../actions/tree';
  import { navigate } from '../../lib/router.svelte';
  import { nostrStore } from '../../nostr';
  import { recentsStore, clearRecentsByPrefix } from '../../stores/recents';
  import { createTreesStore, type TreeEntry } from '../../stores';
  import VisibilityPicker from '../Modals/VisibilityPicker.svelte';
  import BoardCard from './BoardCard.svelte';

  interface Props {
    npub?: string;
  }

  let { npub = undefined }: Props = $props();

  let userNpub = $derived($nostrStore.npub);
  let userPubkey = $derived($nostrStore.pubkey);
  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let targetNpub = $derived(npub || userNpub);
  let showingOwnBoards = $derived(!npub || npub === userNpub);

  let recents = $derived($recentsStore);

  let recentBoards = $derived.by(() => {
    if (npub) return [];
    return recents
      .filter(item => item.treeName?.startsWith('boards/'))
      .map(item => ({
        key: item.path,
        title: item.treeName ? item.treeName.slice(7) : item.label,
        ownerNpub: item.npub || null,
        ownerPubkey: item.npub ? npubToPubkey(item.npub) : null,
        treeName: item.treeName || null,
        visibility: item.visibility,
        href: buildRecentHref(item),
        updatedAt: item.timestamp,
      }));
  });

  let treesStore = $derived(createTreesStore(targetNpub));
  let trees = $state<TreeEntry[]>([]);

  $effect(() => {
    const store = treesStore;
    const unsub = store.subscribe(value => {
      trees = value;
    });
    return unsub;
  });

  let ownBoards = $derived.by(() => {
    return trees
      .filter(tree => tree.name.startsWith('boards/'))
      .map(tree => ({
        key: `/${targetNpub}/${tree.name}`,
        title: tree.name.slice(7),
        ownerNpub: targetNpub || null,
        ownerPubkey: targetNpub ? npubToPubkey(targetNpub) : userPubkey,
        treeName: tree.name,
        visibility: tree.visibility,
        href: `#/${targetNpub}/${encodeURIComponent(tree.name)}${tree.linkKey ? `?k=${tree.linkKey}` : ''}`,
        updatedAt: tree.createdAt ? tree.createdAt * 1000 : 0,
      }));
  });

  let allBoards = $derived.by(() => {
    const dedupe = new SvelteSet<string>();
    const result: typeof ownBoards = [];

    for (const board of recentBoards) {
      const key = `${board.ownerNpub}/${board.treeName}`;
      if (!dedupe.has(key)) {
        dedupe.add(key);
        result.push(board);
      }
    }

    for (const board of ownBoards) {
      const key = `${board.ownerNpub}/${board.treeName}`;
      if (!dedupe.has(key)) {
        dedupe.add(key);
        result.push(board);
      }
    }

    return result.slice(0, 50);
  });

  let showCreate = $state(false);
  let createName = $state('');
  let createVisibility = $state<'public' | 'link-visible' | 'private'>('public');
  let createError = $state('');
  let creating = $state(false);

  function npubToPubkey(npubValue: string): string | null {
    try {
      const decoded = nip19.decode(npubValue);
      if (decoded.type === 'npub') return decoded.data as string;
      return null;
    } catch {
      return null;
    }
  }

  function buildRecentHref(item: { path: string; treeName?: string; npub?: string; linkKey?: string }): string {
    const encodedPath = item.treeName
      ? `/${item.npub}/${encodeURIComponent(item.treeName)}`
      : item.path;
    const base = `#${encodedPath}`;
    return item.linkKey ? `${base}?k=${item.linkKey}` : base;
  }

  async function handleCreateBoard() {
    const name = createName.trim();
    if (!name || creating) return;
    creating = true;
    createError = '';

    try {
      let result: Awaited<ReturnType<typeof createBoardTree>> | null = null;
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          result = await createBoardTree(name, createVisibility);
          break;
        } catch (err) {
          lastError = err;
          const message = err instanceof Error ? err.message : String(err);
          const isWorkerFailure = message.includes('Worker crashed') || message.includes('Request timeout');
          if (!isWorkerFailure || attempt === 2) break;
          await new Promise(resolve => setTimeout(resolve, 1200 * (attempt + 1)));
        }
      }

      if (!result && lastError) {
        throw lastError;
      }
      if (!result) {
        createError = 'Failed to create board.';
        return;
      }

      if (!result.success || !result.npub || !result.treeName) {
        createError = 'Failed to create board.';
        return;
      }
      showCreate = false;
      createName = '';
      const suffix = result.linkKey ? `?k=${result.linkKey}` : '';
      navigate(`/${result.npub}/${encodeURIComponent(result.treeName)}${suffix}`);
    } catch (err) {
      console.error('[Boards] create failed:', err);
      createError = 'Failed to create board.';
    } finally {
      creating = false;
    }
  }
</script>

<div class="flex-1 overflow-auto">
  <div class="max-w-6xl mx-auto p-6 space-y-6">
    {#if recentBoards.length > 0 && !npub}
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold text-text-1">Recent Boards</h2>
        <button class="btn-ghost text-xs text-text-3 hover:text-text-2" onclick={() => clearRecentsByPrefix('boards/')}>
          Clear Recent
        </button>
      </div>
    {/if}

    {#if showingOwnBoards}
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-lg font-semibold text-text-1">Boards</h2>
        {#if isLoggedIn}
          <button class="btn-primary text-sm" onclick={() => showCreate = true}>
            <span class="i-lucide-plus mr-1"></span>
            New Board
          </button>
        {/if}
      </div>
    {/if}

    <div class="grid gap-4" style="grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));">
      {#each allBoards as board (board.href)}
        <BoardCard
          href={board.href}
          title={board.title}
          ownerPubkey={board.ownerPubkey}
          visibility={board.visibility}
          updatedAt={board.updatedAt}
        />
      {/each}
    </div>

    {#if allBoards.length === 0}
      <div class="rounded-lg border border-surface-3 bg-surface-1 p-6 text-text-3 text-sm">
        No boards yet.
      </div>
    {/if}
  </div>
</div>

{#if showCreate}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onclick={() => showCreate = false}>
    <div class="bg-surface-1 rounded-lg shadow-lg w-full max-w-md mx-4 border border-surface-3 p-5 space-y-4" onclick={(e) => e.stopPropagation()}>
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold">Create Board</h3>
        <button class="btn-ghost p-1" onclick={() => showCreate = false} aria-label="Close create board dialog">
          <span class="i-lucide-x"></span>
        </button>
      </div>

      <div class="space-y-3">
        <input
          class="input w-full"
          placeholder="Board name"
          bind:value={createName}
          onkeydown={(e) => e.key === 'Enter' && handleCreateBoard()}
        />
        <VisibilityPicker value={createVisibility} onchange={(value) => createVisibility = value} />
        {#if createError}
          <p class="text-sm text-danger">{createError}</p>
        {/if}
      </div>

      <div class="flex justify-end gap-2">
        <button class="btn-ghost" onclick={() => showCreate = false}>Cancel</button>
        <button class="btn-success" onclick={handleCreateBoard} disabled={creating || !createName.trim()}>
          {creating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}
