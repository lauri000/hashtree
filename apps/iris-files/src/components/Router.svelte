<script lang="ts">
  /**
   * Router component that handles route matching and rendering
   * Receives currentPath as a prop to ensure proper reactivity
   */
  import { matchRoute, currentFullHash, getQueryParamsFromHash } from '../lib/router.svelte';
  import { supportsGitFeatures } from '../appType';

  // Page components
  import SettingsLayout from './settings/SettingsLayout.svelte';
  import WalletPage from './WalletPage.svelte';
  import UsersPage from './UsersPage.svelte';
  import ProfileView from './ProfileView.svelte';
  import GitProfileView from './Git/GitProfileView.svelte';
  import FollowsPage from './FollowsPage.svelte';
  import FollowersPage from './FollowersPage.svelte';
  import EditProfilePage from './EditProfilePage.svelte';
  import { isNHash, isNPath } from '@hashtree/core';
  import { nip19 } from 'nostr-tools';

  // Route handlers
  import HomeRoute from '../routes/HomeRoute.svelte';
  import TreeRoute from '../routes/TreeRoute.svelte';
  import UserRoute from '../routes/UserRoute.svelte';

  // Git repository views (NIP-34)
  import PullRequestsView from './Git/PullRequestsView.svelte';
  import IssuesView from './Git/IssuesView.svelte';
  import PullRequestDetailView from './Git/PullRequestDetailView.svelte';
  import IssueDetailView from './Git/IssueDetailView.svelte';
  import ReleasesView from './Git/ReleasesView.svelte';
  import ReleaseDetailView from './Git/ReleaseDetailView.svelte';
  import CommitView from './Git/CommitView.svelte';
  import CommitFileView from './Git/CommitFileView.svelte';
  import BranchCompareView from './Git/BranchCompareView.svelte';
  import MergeView from './Git/MergeView.svelte';

  // Route definitions with patterns
  // Note: More specific routes must come before less specific ones
  const routePatterns = [
    { pattern: '/', component: HomeRoute },
    { pattern: '/settings', component: SettingsLayout },
    { pattern: '/settings/*', component: SettingsLayout },
    { pattern: '/wallet', component: WalletPage },
    { pattern: '/users', component: UsersPage },
    { pattern: '/:npub/follows', component: FollowsPage },
    { pattern: '/:npub/followers', component: FollowersPage },
    { pattern: '/:npub/edit', component: EditProfilePage },
    { pattern: '/:npub/profile', component: UserRoute },
    // Generic tree routes
    { pattern: '/:npub/:treeName/*', component: TreeRoute },
    { pattern: '/:npub/:treeName', component: TreeRoute },
    { pattern: '/:id/*', component: UserRoute },
    { pattern: '/:id', component: UserRoute },
  ];

  // Check for ?tab=pulls, ?tab=issues, or ?tab=releases query param (repo views)
  // Also check for ?id= to show individual detail views
  // This allows PR/Issues views without interfering with actual directory names
  function parseRepoTabQuery(fullHash: string): { tab: 'pulls' | 'issues' | 'releases'; id?: string } | null {
    if (!supportsGitFeatures()) return null;
    const params = getQueryParamsFromHash(fullHash);
    const tab = params.get('tab');
    if (tab === 'pulls' || tab === 'issues' || tab === 'releases') {
      const id = params.get('id') || undefined;
      return { tab, id };
    }
    return null;
  }

  // Check for ?commit=<hash> query param (commit view)
  function parseCommitQuery(fullHash: string): { hash: string; view: 'commit' | 'file' } | null {
    if (!supportsGitFeatures()) return null;
    const params = getQueryParamsFromHash(fullHash);
    const hash = params.get('commit');
    if (!hash) return null;
    return {
      hash,
      view: params.get('view') === 'file' ? 'file' : 'commit',
    };
  }

  // Check for ?compare=base...head query param (branch comparison view)
  function parseCompareQuery(fullHash: string): { base: string; head: string } | null {
    if (!supportsGitFeatures()) return null;
    const params = getQueryParamsFromHash(fullHash);
    const compare = params.get('compare');
    if (!compare || !compare.includes('...')) return null;
    const [base, head] = compare.split('...');
    return base && head ? { base, head } : null;
  }

  // Check for ?merge=1&base=<base>&head=<head> query param (merge view)
  function parseMergeQuery(fullHash: string): { base: string; head: string; prId?: string; prPubkey?: string } | null {
    if (!supportsGitFeatures()) return null;
    const params = getQueryParamsFromHash(fullHash);
    if (params.get('merge') !== '1') return null;
    const base = params.get('base');
    const head = params.get('head');
    if (!base || !head) return null;
    const prId = params.get('prId') || undefined;
    const prPubkey = params.get('prPubkey') || undefined;
    return { base, head, prId, prPubkey };
  }

  interface Props {
    currentPath: string;
  }

  let { currentPath }: Props = $props();

  // Subscribe to full hash for query param detection
  let fullHash = $derived($currentFullHash);

  // Check for repo tab query param (?tab=pulls, ?tab=issues, ?tab=releases) and optional id
  let repoTabQuery = $derived(parseRepoTabQuery(fullHash));

  // Check for commit query param (?commit=<hash>)
  let commitQuery = $derived(parseCommitQuery(fullHash));

  // Check for branch comparison query param (?compare=base...head)
  let compareQuery = $derived(parseCompareQuery(fullHash));

  // Check for merge query param (?merge=1&base=...&head=...)
  let mergeQuery = $derived(parseMergeQuery(fullHash));

  // Find matching route
  function findRoute(path: string) {
    for (const route of routePatterns) {
      const match = matchRoute(route.pattern, path);
      if (match.matched) {
        return { component: route.component, params: match.params };
      }
    }
    return { component: HomeRoute, params: {} };
  }

  // Derive route from path prop
  let route = $derived.by(() => findRoute(currentPath));

  function parseGitProfileNpub(component: unknown, params: Record<string, string | undefined>): string | null {
    if (!supportsGitFeatures()) return null;
    if (component !== UserRoute) return null;
    const candidate = params.npub || params.id;
    if (!candidate || isNHash(candidate) || isNPath(candidate)) {
      return null;
    }
    try {
      const decoded = nip19.decode(candidate);
      return decoded.type === 'npub' ? candidate : null;
    } catch {
      return null;
    }
  }

  let gitProfileNpub = $derived(parseGitProfileNpub(route.component, route.params));

  // For NIP-34/compare/merge views, we need npub and treeName from the current route
  // The repo path is treeName + any wild path
  let repoPath = $derived.by(() => {
    const { treeName, wild } = route.params;
    if (!treeName) return '';
    return wild ? `${treeName}/${wild}` : treeName;
  });
</script>

<div class="flex-1 flex flex-col lg:flex-row min-h-0">
  {#if mergeQuery && route.params.npub && route.params.treeName}
    <MergeView npub={route.params.npub} repoName={repoPath || route.params.treeName} baseBranch={mergeQuery.base} headBranch={mergeQuery.head} prEventId={mergeQuery.prId} prAuthorPubkey={mergeQuery.prPubkey} />
  {:else if compareQuery && route.params.npub && route.params.treeName}
    <BranchCompareView npub={route.params.npub} repoName={repoPath || route.params.treeName} baseBranch={compareQuery.base} headBranch={compareQuery.head} />
  {:else if commitQuery?.view === 'file' && route.params.npub && route.params.treeName}
    <CommitFileView npub={route.params.npub} commitHash={commitQuery.hash} />
  {:else if commitQuery?.view === 'commit' && route.params.npub && route.params.treeName}
    <CommitView npub={route.params.npub} repoName={repoPath || route.params.treeName} commitHash={commitQuery.hash} />
  {:else if repoTabQuery?.tab === 'pulls' && repoTabQuery.id && route.params.npub && route.params.treeName}
    <PullRequestDetailView npub={route.params.npub} repoName={repoPath} prId={repoTabQuery.id} />
  {:else if repoTabQuery?.tab === 'issues' && repoTabQuery.id && route.params.npub && route.params.treeName}
    <IssueDetailView npub={route.params.npub} repoName={repoPath} issueId={repoTabQuery.id} />
  {:else if repoTabQuery?.tab === 'releases' && repoTabQuery.id && route.params.npub && route.params.treeName}
    <ReleaseDetailView npub={route.params.npub} repoName={repoPath} releaseId={repoTabQuery.id} />
  {:else if repoTabQuery?.tab === 'pulls' && route.params.npub && route.params.treeName}
    <PullRequestsView npub={route.params.npub} repoName={repoPath} />
  {:else if repoTabQuery?.tab === 'issues' && route.params.npub && route.params.treeName}
    <IssuesView npub={route.params.npub} repoName={repoPath} />
  {:else if repoTabQuery?.tab === 'releases' && route.params.npub && route.params.treeName}
    <ReleasesView npub={route.params.npub} repoName={repoPath} />
  {:else if route.component === HomeRoute}
    <HomeRoute />
  {:else if route.component === SettingsLayout}
    <SettingsLayout />
  {:else if route.component === WalletPage}
    <WalletPage />
  {:else if route.component === UsersPage}
    <UsersPage />
  {:else if route.component === FollowsPage}
    <FollowsPage npub={route.params.npub} />
  {:else if route.component === FollowersPage}
    <FollowersPage npub={route.params.npub} />
  {:else if route.component === EditProfilePage}
    <EditProfilePage npub={route.params.npub} />
  {:else if gitProfileNpub}
    <GitProfileView npub={gitProfileNpub} />
  {:else if route.component === ProfileView}
    <ProfileView npub={route.params.npub || ''} />
  {:else if route.component === TreeRoute}
    <TreeRoute npub={route.params.npub} treeName={route.params.treeName} wild={route.params.wild} />
  {:else if route.component === UserRoute}
    <UserRoute id={route.params.id || route.params.npub} wild={route.params.wild} />
  {:else}
    <HomeRoute />
  {/if}
</div>
