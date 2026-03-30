<script lang="ts">
  /**
   * GitRepoView - GitHub-style directory listing with README below
   * Shows branch info, file list table, then README.md in its own panel
   */
  import { LinkType, type CID, type TreeEntry, type TreeVisibility } from '@hashtree/core';
  import type { Readable } from 'svelte/store';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { getTree, decodeAsText } from '../../store';
  import { routeStore } from '../../stores';
  import { nostrStore } from '../../nostr';
  import { createGitLogStore, createGitStatusStore } from '../../stores/git';
  import { createCIStatusStore, loadCIConfig, type CIStatus, type CIConfig } from '../../stores/ci';
  import { createFavoriteRepoStatsStore, createFavoriteReposStore, createRepoForkStatsStore, toggleFavoriteRepo } from '../../stores';
  import { open as openGitHistoryModal } from '../Modals/GitHistoryModal.svelte';
    import { open as openGitCommitModal } from '../Modals/GitCommitModal.svelte';
  import { getFileLastCommits } from '../../utils/git';
  import FolderActions from '../FolderActions.svelte';
  import ReadmePanel from '../Viewer/ReadmePanel.svelte';
  import RepoTabNav from './RepoTabNav.svelte';
  import RepoHeader from './RepoHeader.svelte';
  import RepoSidebar from './RepoSidebar.svelte';
  import BranchDropdown from './BranchDropdown.svelte';
  import FileTable from './FileTable.svelte';
  import type { GitStatusResult } from '../../utils/wasmGit';
  import type { CommitInfo } from '../../stores/git';
  import CodeDropdown from './CodeDropdown.svelte';
  import { buildRepoAddress } from '../../nip34';
  import type { FavoriteRepoRef } from '../../lib/gitFavorites';
  import { resolveGitRootPathParam, resolveGitViewContext, splitGitRootPath } from '../../utils/gitViewContext';

  interface Props {
    dirCid: CID;
    /** Git root CID - use this for git operations when in a subdirectory */
    gitRootCid: CID | null;
    /** Git root path from tree root, or empty string when the tree root is the repo root */
    gitRootPath: string | null;
    /** When false, render repo layout immediately but defer git metadata until root detection resolves */
    loadGitMetadata?: boolean;
    entries: TreeEntry[];
    canEdit: boolean;
    currentBranch: string | null;
    branches: string[];
    tags: string[];
    tagsByCommit: Record<string, string[]>;
    backUrl: string;
    npub?: string | null;
    isPermalink?: boolean;
    rootCid?: CID | null;
    visibility?: TreeVisibility;
  }

  let {
    dirCid,
    gitRootCid,
    gitRootPath,
    loadGitMetadata = true,
    entries,
    canEdit,
    currentBranch,
    branches,
    tags,
    tagsByCommit,
    backUrl,
    npub = null,
    isPermalink = false,
    rootCid = null,
    visibility,
  }: Props = $props();

  // Use gitRootCid for git operations once root detection is ready.
  let gitCid = $derived(loadGitMetadata ? (gitRootCid ?? dirCid) : null);

  let route = $derived($routeStore);
  let currentPath = $derived(route.path);
  let gitRootPathParam = $derived(resolveGitRootPathParam(gitRootPath, currentPath));
  let gitRootParts = $derived(splitGitRootPath(gitRootPathParam) ?? []);
  let userNpub = $derived($nostrStore.npub);
  let gitViewContext = $derived.by(() => resolveGitViewContext({
    treeName: route.treeName,
    gitRootPath,
    fallbackGitRootParts: gitRootPath === null ? currentPath : [],
    currentPath,
  }));

  // Full repo path for URLs (treeName + path to git root)
  // e.g., if treeName is "link" and git root is at "link/my-repo", repoPath is "link/my-repo"
  let repoPath = $derived.by(() => {
    const gitPath = gitViewContext.rootParts;
    if (!route.treeName) return '';
    if (gitPath.length === 0) return route.treeName;
    return `${route.treeName}/${gitPath.join('/')}`;
  });

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

  let repoAddress = $derived.by(() => {
    if (!route.npub || !repoPath) return null;
    return buildRepoAddress(route.npub, repoPath);
  });
  let isFavorited = $derived(repoAddress ? favoriteRepos.some(repo => repo.address === repoAddress) : false);
  let canFavoriteRepo = $derived(!!route.npub && !route.params.get('k') && visibility !== 'private' && visibility !== 'link-visible');
  let favoriteLoading = $state(false);
  let favoriteOptimisticState = $state<boolean | null>(null);
  let favoriteOptimisticCount = $state<number | null>(null);
  let favoriteRepoStatsStore = $derived(
    route.npub && repoPath ? createFavoriteRepoStatsStore(route.npub, repoPath) : null,
  );
  let favoriteRepoCount = $state(0);
  let displayedIsFavorited = $derived(favoriteOptimisticState ?? isFavorited);
  let displayedFavoriteCount = $derived(favoriteOptimisticCount ?? favoriteRepoCount);
  let showRepoForkStats = $derived(!!route.npub && !route.params.get('k') && visibility !== 'private' && visibility !== 'link-visible');
  let repoForkStatsStore = $derived(
    showRepoForkStats && route.npub && repoPath ? createRepoForkStatsStore(route.npub, repoPath) : null,
  );
  let repoForkCount = $state(0);

  $effect(() => {
    repoAddress;
    favoriteOptimisticState = null;
    favoriteOptimisticCount = null;
  });

  $effect(() => {
    if (favoriteOptimisticState !== null && isFavorited === favoriteOptimisticState) {
      favoriteOptimisticState = null;
    }
  });

  $effect(() => {
    if (favoriteOptimisticCount !== null && favoriteRepoCount === favoriteOptimisticCount) {
      favoriteOptimisticCount = null;
    }
  });

  $effect(() => {
    if (!favoriteRepoStatsStore) {
      favoriteRepoCount = 0;
      return;
    }

    const unsub = favoriteRepoStatsStore.subscribe(value => {
      favoriteRepoCount = value?.count || 0;
    });

    return () => {
      unsub();
      favoriteRepoStatsStore?.destroy();
    };
  });

  $effect(() => {
    if (!repoForkStatsStore) {
      repoForkCount = 0;
      return;
    }

    const unsub = repoForkStatsStore.subscribe(value => {
      repoForkCount = value?.count || 0;
    });

    return () => {
      unsub();
      repoForkStatsStore?.destroy();
    };
  });

  // Create git log store - use gitCid (git root) for log, keyed by repoPath
  let gitLogStore = $derived(createGitLogStore(gitCid, 50, repoPath));
  let commits = $state<CommitInfo[]>([]);
  let headOid = $state<string | null>(null);
  let commitsLoading = $state(true);

  // Total commit count (loaded fast via pack scanning)
  let totalCommitCount = $state<number | null>(null);

  // Load total commit count in background
  $effect(() => {
    const cid = gitCid;
    totalCommitCount = null;
    if (!cid) {
      return;
    }
    let cancelled = false;

    import('../../utils/wasmGit').then(({ getCommitCountFast }) => {
      if (cancelled) return;
      getCommitCountFast(cid).then(count => {
        if (!cancelled && count > 0) {
          totalCommitCount = count;
        }
      });
    });

    return () => { cancelled = true; };
  });

  // Latest commit for the header row
  let latestCommit = $derived(commits.length > 0 ? commits[0] : null);

  // File last commit info (GitHub-style)
  let fileCommits = $state<Map<string, { oid: string; message: string; timestamp: number }>>(new Map());

  // CI config and status
  let ciConfig = $state<CIConfig | null>(null);
  let ciStatus = $state<CIStatus | null>(null);
  let ciStatusStore = $state<Readable<CIStatus> | null>(null);

  $effect(() => {
    const store = gitLogStore;
    const unsub = store.subscribe(value => {
      commits = value.commits;
      headOid = value.headOid;
      commitsLoading = value.loading;
    });
    return unsub;
  });

  // Track which ref we're switching to (null = not switching)
  let switchingToRef = $state<string | null>(null);

  let selectedTag = $derived.by(() => {
    if (currentBranch || !headOid) return null;
    const matchingTags = tagsByCommit[headOid] ?? [];
    return matchingTags[0] ?? null;
  });

  // Detached HEAD state - show short commit hash instead of branch name
  // While switching, show the target ref name optimistically
  let branchDisplay = $derived(
    switchingToRef || currentBranch || selectedTag || (headOid ? headOid.slice(0, 7) : (loadGitMetadata ? 'detached' : 'loading'))
  );

  // Clear switchingToRef once the selected branch/tag catches up
  $effect(() => {
    if (switchingToRef && (currentBranch === switchingToRef || selectedTag === switchingToRef)) {
      switchingToRef = null;
    }
  });

  // Handle ?branch= URL parameter - automatically switch to specified branch
  $effect(() => {
    if (!loadGitMetadata) return;
    const targetBranch = route.params.get('branch');
    const current = currentBranch;
    const availableBranches = branches;

    // Skip if no target branch specified, already on target, or branch doesn't exist
    if (!targetBranch || targetBranch === current || !availableBranches.includes(targetBranch)) {
      return;
    }

    // Skip if already switching
    if (switchingToRef) return;

    // Auto-switch to the branch from URL (handleRefSelect manages switchingToRef state)
    handleRefSelect(targetBranch);
  });

  // Calculate subdirectory path relative to git root
  // gitRootPath is the path to git root (e.g., "my-repo"), currentPath is full path (e.g., ["my-repo", "src"])
  // We need to compute the subpath within the git repo (e.g., "src")
  let gitSubpath = $derived.by(() => {
    // Get the git root path as an array
    const resolvedGitRootParts = gitRootPath !== null
      ? (gitRootPath === '' ? [] : gitRootPath.split('/'))
      : currentPath; // If gitRootPath is null, we're at git root, so use currentPath as git root

    // If we're at git root level (gitRootPath null), subpath is empty
    if (gitRootPath === null) {
      return '';
    }

    // currentPath should start with gitRootParts
    // The subpath is everything after gitRootParts
    if (currentPath.length <= resolvedGitRootParts.length) {
      return ''; // At git root
    }

    return currentPath.slice(resolvedGitRootParts.length).join('/');
  });

  // Load file last commit info when entries or gitCid change
  // Use gitCid for git operations, but track entries for file names
  $effect(() => {
    // Access props to track them for reactivity
    const cid = gitCid;
    const filenames = entries.map(e => e.name);
    const subpath = gitSubpath;

    if (!cid || filenames.length === 0) {
      fileCommits = new Map();
      return;
    }

    let cancelled = false;
    getFileLastCommits(cid, filenames, subpath || undefined).then(result => {
      if (!cancelled) {
        fileCommits = result;
      }
    }).catch(() => {
      // Silently ignore errors
    });
    return () => { cancelled = true; };
  });

  // Find and load README.md
  let readmeContent = $state<string | null>(null);

  $effect(() => {
    readmeContent = null;
    const readmeEntry = entries.find(
      e => e.name.toLowerCase() === 'readme.md' && e.type !== LinkType.Dir
    );
    if (!readmeEntry) return;

    let cancelled = false;
    getTree().readFile(readmeEntry.cid).then(data => {
      if (!cancelled && data) {
        const text = decodeAsText(data);
        if (text) readmeContent = text;
      }
    });
    return () => { cancelled = true; };
  });

  // Git status store - use gitCid (git root) for status
  let gitStatusStore = $derived(createGitStatusStore(gitCid));
  let gitStatus = $state<GitStatusResult>({ staged: [], unstaged: [], untracked: [], hasChanges: false });
  let statusLoading = $state(true);

  // Track gitCid changes to reset status (use a ref to avoid triggering effects)
  let lastGitCidRef: { current: string | null } = { current: null };

  $effect(() => {
    const store = gitStatusStore;

    // If gitCid changed, reset to loading state immediately
    if (lastGitCidRef.current !== gitCid) {
      gitStatus = { staged: [], unstaged: [], untracked: [], hasChanges: false };
      statusLoading = true;
      lastGitCidRef.current = gitCid;
    }

    const unsub = store.subscribe(value => {
      gitStatus = value.status;
      statusLoading = value.loading;
    });
    return unsub;
  });

  // Total changes count
  let totalChanges = $derived(
    gitStatus.staged.length +
    gitStatus.unstaged.length +
    gitStatus.untracked.length
  );

  // Build query string for entry hrefs
  function buildQueryString(): string {
    const params: string[] = [];
    if (route.params.get('k')) params.push(`k=${route.params.get('k')}`);
    params.push(`g=${encodeURIComponent(gitRootPathParam)}`);
    return params.length > 0 ? '?' + params.join('&') : '';
  }

  function buildEntryHref(entry: TreeEntry): string {
    const parts: string[] = [];
    const suffix = buildQueryString();

    if (route.npub && route.treeName) {
      parts.push(route.npub, route.treeName, ...currentPath, entry.name);
      return '#/' + parts.map(encodeURIComponent).join('/') + suffix;
    }

    parts.push(...currentPath, entry.name);
    return '#/' + parts.map(encodeURIComponent).join('/') + suffix;
  }

  function buildCommitHref(commitOid: string): string {
    const parts: string[] = [];
    const params = new SvelteURLSearchParams();

    params.set('commit', commitOid);
    if (route.params.get('k')) params.set('k', route.params.get('k')!);

    params.set('g', gitRootPathParam);

    if (route.npub && route.treeName) {
      parts.push(route.npub, route.treeName, ...currentPath);
    }
    const basePath = '#/' + parts.map(encodeURIComponent).join('/');
    return `${basePath}?${params.toString()}`;
  }

  function openHistory() {
    if (!gitCid) return;
    openGitHistoryModal({
      dirCid: gitCid,
      canEdit,
      onCheckout: canEdit ? handleCheckout : undefined,
      repoPath,
      gitRootPath: gitRootPathParam,
    });
  }

  function openCommit() {
    if (!gitCid) return;
    openGitCommitModal({ dirCid: gitCid, onCommit: handleCommit });
  }

  async function handleFavoriteToggle() {
    if (!route.npub) return;
    if (!userNpub) {
      alert('Please sign in to like public repositories');
      return;
    }

    const nextFavorited = !displayedIsFavorited;
    const nextFavoriteCount = Math.max(0, displayedFavoriteCount + (nextFavorited ? 1 : -1));

    favoriteOptimisticState = nextFavorited;
    favoriteOptimisticCount = nextFavoriteCount;
    favoriteLoading = true;
    try {
      await toggleFavoriteRepo(route.npub, repoPath);
    } catch (err) {
      favoriteOptimisticState = null;
      favoriteOptimisticCount = null;
      console.error('Failed to update repository like:', err);
    } finally {
      favoriteLoading = false;
    }
  }

  // Build parent directory href (for ".." navigation)
  let parentHref = $derived.by(() => {
    if (currentPath.length === 0) return null; // At root, no parent
    const parts: string[] = [];
    const parentPath = currentPath.slice(0, -1);
    const suffix = buildQueryString();

    if (route.npub && route.treeName) {
      parts.push(route.npub, route.treeName, ...parentPath);
      return '#/' + parts.map(encodeURIComponent).join('/') + suffix;
    }

    parts.push(...parentPath);
    return '#/' + parts.map(encodeURIComponent).join('/') + suffix;
  });

  $effect(() => {
    ciConfig = null;
    const cid = gitCid;
    if (!cid) return;
    let cancelled = false;
    loadCIConfig(cid).then(result => {
      if (!cancelled) ciConfig = result;
    }).catch(() => {
      if (!cancelled) ciConfig = null;
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    ciStatus = null;
    ciStatusStore = null;
    const commit = headOid ?? latestCommit?.oid ?? null;
    const path = repoPath;
    if (!ciConfig || !commit || !path) return;
    if (!ciConfig.runners || ciConfig.runners.length === 0) return;
    const store = createCIStatusStore(path, commit, ciConfig.runners);
    ciStatusStore = store;
    const unsub = store.subscribe(value => {
      ciStatus = value;
    });
    return () => {
      ciStatusStore = null;
      unsub();
    };
  });


  // Handle branch selection - checkout the branch
  async function handleRefSelect(ref: string) {
    if (!gitCid) return;
    // Skip if already on this ref or already switching
    if (ref === currentBranch || ref === selectedTag || switchingToRef) return;

    switchingToRef = ref;

    try {
      const { checkoutCommit } = await import('../../utils/git');
      const { autosaveIfOwn } = await import('../../nostr');
      const { getCurrentRootCid } = await import('../../actions/route');

      // Get current tree root
      const treeRootCid = getCurrentRootCid();
      if (!treeRootCid) return;

      // Checkout the ref - use gitCid for git operations
      const newDirCid = await checkoutCommit(gitCid, ref);

      // Determine the path to the git root (use gitRootPath if in subdirectory, otherwise currentPath)
      const gitPath = gitRootParts;

      let newRootCid;
      if (gitPath.length === 0) {
        // Git repo is at tree root
        newRootCid = newDirCid;
      } else {
        // Git repo is in a subdirectory - replace it at that path
        const tree = getTree();
        const parentPath = gitPath.slice(0, -1);
        const dirName = gitPath[gitPath.length - 1];
        newRootCid = await tree.setEntry(
          treeRootCid,
          parentPath,
          dirName,
          newDirCid,
          0,
          LinkType.Dir
        );
      }

      // Save and publish - UI will react automatically via store subscriptions
      autosaveIfOwn(newRootCid);
    } catch (err) {
      console.error('Failed to switch ref:', err);
      switchingToRef = null;
    }
  }

  // Helper to get git path (either from URL param or current path if at git root)
  function getGitPath(): string[] {
    return gitRootParts;
  }

  // Handle commit callback - replaces the git repo at its path
  async function handleCommit(newDirCid: CID): Promise<void> {
    if (!gitCid) return;
    const { autosaveIfOwn } = await import('../../nostr');
    const { getCurrentRootCid } = await import('../../actions/route');

    // Get current tree root
    const treeRootCid = getCurrentRootCid();
    if (!treeRootCid) return;

    const gitPath = getGitPath();
    let newRootCid;
    if (gitPath.length === 0) {
      // Git repo is at tree root - just use the new CID directly
      newRootCid = newDirCid;
    } else {
      // Git repo is in a subdirectory - replace it at that path
      const tree = getTree();
      const parentPath = gitPath.slice(0, -1);
      const dirName = gitPath[gitPath.length - 1];
      newRootCid = await tree.setEntry(
        treeRootCid,
        parentPath,
        dirName,
        newDirCid,
        0,
        LinkType.Dir
      );
    }

    // Save and publish - UI will react automatically via store subscriptions
    autosaveIfOwn(newRootCid);
  }

  // Handle checkout from history modal
  async function handleCheckout(commitSha: string): Promise<void> {
    if (!gitCid) return;
    const { checkoutCommit } = await import('../../utils/git');
    const { autosaveIfOwn } = await import('../../nostr');
    const { getCurrentRootCid } = await import('../../actions/route');

    // Get current tree root
    const treeRootCid = getCurrentRootCid();
    if (!treeRootCid) return;

    // Checkout the commit - use gitCid for git operations
    const newDirCid = await checkoutCommit(gitCid, commitSha);

    const gitPath = getGitPath();
    let newRootCid;
    if (gitPath.length === 0) {
      // Git repo is at tree root - just use the new CID directly
      newRootCid = newDirCid;
    } else {
      // Git repo is in a subdirectory - replace it at that path
      const tree = getTree();
      const parentPath = gitPath.slice(0, -1);
      const dirName = gitPath[gitPath.length - 1];
      newRootCid = await tree.setEntry(
        treeRootCid,
        parentPath,
        dirName,
        newDirCid,
        0,
        LinkType.Dir
      );
    }

    // Save and publish - UI will react automatically via store subscriptions
    autosaveIfOwn(newRootCid);
  }

</script>

<!-- Tab navigation for Code/PRs/Issues - show for any git repo (not just tree root) -->
{#if route.npub && route.treeName}
  <RepoTabNav npub={route.npub} repoName={repoPath} activeTab="code" showReleasesTab={false} />
{/if}

<div class="mx-auto flex w-full max-w-7xl flex-col gap-4 p-3">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <RepoHeader
      {backUrl}
      repoName={repoPath}
      {npub}
      {visibility}
      {isPermalink}
      {rootCid}
    />

    <div class="flex max-w-full min-w-0 items-center justify-end max-sm:w-full max-sm:justify-start">
      <FolderActions dirCid={gitRootCid ?? null} {canEdit} />
    </div>
  </div>

  <div class="flex flex-col gap-4 lg:flex-row lg:items-start">
    <div class="min-w-0 flex-1 flex flex-col gap-4" data-testid="repo-main-column">
    <!-- Branch selector row (above table, like GitHub) -->
    <div class="flex flex-wrap items-center gap-3 text-sm">
      {#if gitCid}
        <!-- Branch dropdown - use gitCid for git operations -->
        <BranchDropdown
          {branches}
          {currentBranch}
          {tags}
          {selectedTag}
          {branchDisplay}
          {canEdit}
          dirCid={gitCid}
          npub={route.npub}
          {repoPath}
          onRefSelect={handleRefSelect}
          loading={!!switchingToRef}
        />
      {:else}
        <button class="btn-ghost flex items-center gap-1 px-3 h-9 text-sm" disabled>
          <span class="i-lucide-loader-2 animate-spin"></span>
          <span>Loading repo</span>
        </button>
      {/if}

      <!-- Branch count -->
      <span class="flex items-center gap-1.5 text-sm text-text-2">
        <span class="i-lucide-git-branch text-text-3"></span>
        <span>{gitCid ? `${branches.length} branch${branches.length !== 1 ? 'es' : ''}` : 'Detecting branches...'}</span>
      </span>

      {#if gitCid}
        <span class="flex items-center gap-1.5 text-sm text-text-2">
          <span class="i-lucide-tag text-text-3"></span>
          <span>{tags.length} tag{tags.length !== 1 ? 's' : ''}</span>
        </span>
      {/if}

      <!-- Git status indicator and commit button -->
      {#if canEdit}
        {#if !gitCid || statusLoading}
          <span class="text-text-3 text-xs flex items-center gap-1">
            <span class="i-lucide-loader-2 animate-spin"></span>
          </span>
        {:else if totalChanges > 0}
          <button
            onclick={openCommit}
            class="btn-ghost flex items-center gap-1 px-2 h-8 text-sm"
            title="{totalChanges} uncommitted change{totalChanges !== 1 ? 's' : ''}"
          >
            <span class="i-lucide-git-commit text-warning"></span>
            <span class="text-warning">{totalChanges}</span>
            <span class="hidden sm:inline">uncommitted</span>
          </button>
        {:else}
          <span class="text-text-3 text-xs flex items-center gap-1" title="No uncommitted changes">
            <span class="i-lucide-check-circle text-success"></span>
            <span class="hidden sm:inline">clean</span>
          </span>
        {/if}
      {/if}

      <!-- Spacer -->
      <div class="flex-1"></div>

      <!-- Commits count (clickable) -->
      <button
        onclick={openHistory}
        class="flex items-center gap-1.5 text-sm text-text-2 hover:text-accent bg-transparent b-0 cursor-pointer"
        disabled={!gitCid}
      >
        {#if gitCid && totalCommitCount !== null}
          <span class="i-lucide-history text-text-3"></span>
          <span>{totalCommitCount} commits</span>
        {:else}
          <span class="i-lucide-loader-2 animate-spin text-text-3"></span>
        {/if}
      </button>


      <!-- Code dropdown (clone instructions) - rightmost -->
      {#if route.npub}
        {#if canFavoriteRepo}
          <button
            onclick={handleFavoriteToggle}
            class={`btn-ghost flex items-center gap-2 px-3 h-9 ${displayedIsFavorited ? 'text-accent border-accent/30 bg-accent/10 hover:bg-accent/15' : ''}`}
            disabled={favoriteLoading}
            title={displayedIsFavorited ? 'Remove your like from this repository' : 'Like this repository'}
          >
            <span class={`i-lucide-heart ${displayedIsFavorited ? 'fill-current' : ''}`}></span>
            <span>{displayedIsFavorited ? 'Liked' : 'Like'}</span>
            <span class="text-xs text-text-2">{displayedFavoriteCount}</span>
          </button>
        {/if}
        {#if showRepoForkStats}
          <div
            class="flex items-center gap-2 px-3 h-9 rounded-lg border border-surface-3 bg-surface-1 text-sm text-text-2"
            title="Personal forks announced via NIP-34"
          >
            <span class="i-lucide-git-fork"></span>
            <span>Forks</span>
            <span class="text-xs text-text-2">{repoForkCount}</span>
          </div>
        {/if}
        <CodeDropdown npub={route.npub} {repoPath} />
      {/if}
    </div>

    <!-- Directory listing table - GitHub style -->
    <div class="b-1 b-surface-3 b-solid rounded-lg overflow-hidden bg-surface-0" data-testid="file-list">
      <!-- File table with commit info header -->
      <FileTable
        {entries}
        {fileCommits}
        {buildEntryHref}
        {buildCommitHref}
        {latestCommit}
        latestCommitTags={latestCommit ? (tagsByCommit[latestCommit.oid] ?? []) : []}
        commitsLoading={!loadGitMetadata || commitsLoading}
        {parentHref}
        {ciStatus}
        {ciStatusStore}
        {repoPath}
        {ciConfig}
      />
    </div>

    <!-- README.md panel -->
    {#if readmeContent}
      <ReadmePanel content={readmeContent} {entries} {canEdit} />
    {/if}
    </div>

    {#if route.npub && repoPath}
      <RepoSidebar npub={route.npub} repoName={repoPath} repoCid={gitCid} />
    {/if}
  </div>
</div>
