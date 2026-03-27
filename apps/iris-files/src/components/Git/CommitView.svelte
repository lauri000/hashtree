<script lang="ts">
  /**
   * CommitView - Shows details of a single git commit
   * Displays commit metadata and GitHub-style per-file patches.
   */
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { getTree } from '../../store';
  import { getCommitViewData } from '../../utils/git';
  import { getErrorMessage } from '../../utils/errorMessage';
  import { routeStore, treeRootStore, createTreesStore, currentDirCidStore } from '../../stores';
  import { findNearestGitRootPath } from '../../utils/gitRoot';
  import { hasAmbiguousEmptyGitRootHint } from '../../utils/gitViewContext';
  import ViewerHeader from '../Viewer/ViewerHeader.svelte';
  import RepoTabNav from './RepoTabNav.svelte';

  interface Props {
    npub: string;
    repoName: string;
    commitHash: string;
  }

  type CommitFile = {
    path: string;
    status: 'added' | 'deleted' | 'modified';
    patch: string;
    additions: number;
    deletions: number;
    isBinary: boolean;
    canViewFile: boolean;
    viewCommit: string | null;
  };

  let { npub, repoName, commitHash }: Props = $props();

  let route = $derived($routeStore);
  let rootCid = $derived($treeRootStore);
  let dirCid = $derived($currentDirCidStore);
  let gitRootCid = $state<typeof dirCid>(null);

  let treesStore = $derived(createTreesStore(npub));
  let trees = $state<Array<{ name: string; visibility?: string }>>([]);

  $effect(() => {
    const store = treesStore;
    const unsub = store.subscribe(value => {
      trees = value;
    });
    return unsub;
  });

  let baseTreeName = $derived(repoName.split('/')[0]);
  let currentTree = $derived(trees.find(t => t.name === baseTreeName));
  let gitRootPath = $derived(route.params.get('g'));
  let detectedGitRootPath = $state<string | null>(null);
  let hasAmbiguousGitRootHint = $derived(hasAmbiguousEmptyGitRootHint(gitRootPath, route.path));
  let routeGitRootHint = $derived(hasAmbiguousGitRootHint ? null : gitRootPath);
  let effectiveGitRootPath = $derived(routeGitRootHint ?? detectedGitRootPath);
  let repoRootParts = $derived.by(() => {
    if (effectiveGitRootPath !== null) {
      return effectiveGitRootPath === '' ? [] : effectiveGitRootPath.split('/');
    }
    return route.path;
  });

  let backUrl = $derived.by(() => {
    const linkKeySuffix = route.params.get('k') ? `?k=${route.params.get('k')}` : '';
    return `#/${npub}/${repoName}${linkKeySuffix}`;
  });

  let commitData = $state<{
    hash: string;
    author: string;
    email: string;
    date: string;
    message: string;
    stats: { additions: number; deletions: number; files: number };
    files: CommitFile[];
  } | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    const explicitGitRoot = routeGitRootHint;
    const treeCid = rootCid;
    const path = route.path;

    if (explicitGitRoot !== null || !treeCid) {
      detectedGitRootPath = null;
      return;
    }

    let cancelled = false;
    findNearestGitRootPath(treeCid, path).then((resolvedPath) => {
      if (!cancelled) {
        detectedGitRootPath = resolvedPath;
      }
    }).catch(() => {
      if (!cancelled) {
        detectedGitRootPath = null;
      }
    });

    return () => { cancelled = true; };
  });

  $effect(() => {
    const explicitGitRoot = effectiveGitRootPath;
    const treeCid = rootCid;
    const currentDir = dirCid;

    if (explicitGitRoot === null || !treeCid) {
      gitRootCid = currentDir;
      return;
    }

    const path = explicitGitRoot === '' ? [] : explicitGitRoot.split('/');
    if (path.length === 0) {
      gitRootCid = treeCid;
      return;
    }

    let cancelled = false;
    getTree().resolvePath(treeCid, path.join('/')).then((resolved) => {
      if (!cancelled) {
        gitRootCid = resolved?.cid ?? null;
      }
    }).catch(() => {
      if (!cancelled) {
        gitRootCid = null;
      }
    });

    return () => { cancelled = true; };
  });

  $effect(() => {
    if (!gitRootCid || !commitHash) return;

    loading = true;
    error = null;
    commitData = null;

    let cancelled = false;

    (async () => {
      try {
        const data = await getCommitViewData(gitRootCid, commitHash);

        if (cancelled) return;

        if (!data) {
          error = `Commit ${commitHash} not found`;
          loading = false;
          return;
        }

        commitData = {
          hash: data.commit.oid,
          author: data.commit.author,
          email: data.commit.email,
          date: new Date(data.commit.timestamp * 1000).toISOString(),
          message: data.commit.message,
          stats: data.stats,
          files: data.files.map((file) => ({
            path: file.path,
            status: file.status,
            patch: file.patch,
            additions: file.additions,
            deletions: file.deletions,
            isBinary: file.isBinary,
            canViewFile: file.canViewFile,
            viewCommit: file.viewCommit,
          })),
        };
        loading = false;
      } catch (err) {
        if (!cancelled) {
          error = getErrorMessage(err);
          loading = false;
        }
      }
    })();

    return () => { cancelled = true; };
  });

  function formatDate(isoDate: string): string {
    try {
      const date = new Date(isoDate);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoDate;
    }
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function colorizePatch(patch: string): string {
    return patch.split('\n').map(line => {
      const escaped = escapeHtml(line);

      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<span class="text-success">${escaped}</span>`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `<span class="text-error">${escaped}</span>`;
      }
      if (line.startsWith('@@')) {
        return `<span class="text-accent">${escaped}</span>`;
      }
      if (
        line.startsWith('Binary files') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('---') ||
        line.startsWith('+++')
      ) {
        return `<span class="text-text-3">${escaped}</span>`;
      }
      return escaped;
    }).join('\n');
  }

  function getStatusLabel(status: CommitFile['status']): string {
    if (status === 'added') return 'Added';
    if (status === 'deleted') return 'Deleted';
    return 'Modified';
  }

  function getStatusClass(status: CommitFile['status']): string {
    if (status === 'added') return 'text-success bg-success/10';
    if (status === 'deleted') return 'text-error bg-error/10';
    return 'text-accent bg-accent/10';
  }

  function buildFileHref(file: CommitFile): string {
    const params = new SvelteURLSearchParams();
    params.set('commit', file.viewCommit ?? commitHash);
    params.set('view', 'file');
    if (route.params.get('k')) params.set('k', route.params.get('k')!);
    params.set('g', effectiveGitRootPath ?? '');

    const parts = [
      npub,
      route.treeName ?? baseTreeName,
      ...repoRootParts,
      ...file.path.split('/').filter(Boolean),
    ];

    return `#/${parts.map(encodeURIComponent).join('/')}?${params.toString()}`;
  }

  let browseFilesUrl = $derived(backUrl);
</script>

<div class="flex flex-1 flex-col min-w-0 min-h-0 bg-surface-0">
  <ViewerHeader
    {backUrl}
    {npub}
    {rootCid}
    visibility={currentTree?.visibility}
    icon="i-lucide-git-commit text-warning"
    name={commitHash.slice(0, 7)}
  />

  <RepoTabNav {npub} {repoName} activeTab="code" />

  <div class="flex-1 overflow-auto p-4">
    {#if loading}
      <div class="flex items-center justify-center py-12 text-text-3">
        <span class="i-lucide-loader-2 animate-spin mr-2"></span>
        Loading commit...
      </div>
    {:else if error}
      <div class="flex flex-col items-center justify-center py-12 text-danger">
        <span class="i-lucide-alert-circle text-2xl mb-2"></span>
        <span>{error}</span>
      </div>
    {:else if commitData}
      <div class="bg-surface-1 rounded-lg b-1 b-solid b-surface-3 overflow-hidden mb-4">
        <div class="p-4">
          <h1 class="text-lg font-semibold text-text-1 mb-3 whitespace-pre-wrap">{commitData.message.split('\n')[0]}</h1>

          {#if commitData.message.includes('\n')}
            <pre class="text-sm text-text-2 whitespace-pre-wrap mb-4">{commitData.message.split('\n').slice(1).join('\n').trim()}</pre>
          {/if}

          <div class="flex flex-wrap items-center gap-4 text-sm text-text-2">
            <div class="flex items-center gap-2">
              <span class="i-lucide-user text-text-3"></span>
              <span class="font-medium">{commitData.author}</span>
              {#if commitData.email}
                <span class="text-text-3">&lt;{commitData.email}&gt;</span>
              {/if}
            </div>
            <div class="flex items-center gap-2">
              <span class="i-lucide-calendar text-text-3"></span>
              <span>{formatDate(commitData.date)}</span>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3 mt-4 pt-4 b-t-1 b-t-solid b-t-surface-3">
            <code class="text-xs bg-surface-2 px-2 py-1 rounded font-mono">{commitData.hash}</code>
            <a href={browseFilesUrl} class="btn-ghost text-sm flex items-center gap-1">
              <span class="i-lucide-folder"></span>
              Browse files
            </a>
          </div>
        </div>

        <div class="px-4 py-2 bg-surface-2 flex items-center gap-4 text-sm">
          <span class="text-text-2">
            <span class="font-medium">{commitData.stats.files}</span> file{commitData.stats.files !== 1 ? 's' : ''} changed
          </span>
          {#if commitData.stats.additions > 0}
            <span class="text-success">+{commitData.stats.additions}</span>
          {/if}
          {#if commitData.stats.deletions > 0}
            <span class="text-error">-{commitData.stats.deletions}</span>
          {/if}
        </div>
      </div>

      {#if commitData.files.length > 0}
        <div class="flex flex-col gap-4">
          {#each commitData.files as file (file.path)}
            <div
              class="bg-surface-1 rounded-lg b-1 b-solid b-surface-3 overflow-hidden"
              data-testid="commit-changed-file"
              data-file-path={file.path}
            >
              <div class="px-4 py-2 b-b-1 b-b-solid b-b-surface-3 flex flex-wrap items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="i-lucide-file-diff text-text-3 shrink-0"></span>
                  <span class="font-mono text-sm text-text-1 truncate">{file.path}</span>
                  <span class={`px-2 py-0.5 rounded text-xs font-medium ${getStatusClass(file.status)}`}>
                    {getStatusLabel(file.status)}
                  </span>
                </div>
                <div class="flex items-center gap-3 text-xs">
                  {#if file.additions > 0}
                    <span class="text-success">+{file.additions}</span>
                  {/if}
                  {#if file.deletions > 0}
                    <span class="text-error">-{file.deletions}</span>
                  {/if}
                  {#if file.canViewFile && file.viewCommit}
                    <a href={buildFileHref(file)} class="btn-ghost px-2 py-1 no-underline">
                      View file
                    </a>
                  {/if}
                </div>
              </div>
              {#if file.patch}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- colorizePatch escapes HTML -->
                <pre class="p-4 text-xs font-mono overflow-x-auto whitespace-pre">{@html colorizePatch(file.patch)}</pre>
              {:else if file.isBinary}
                <div class="p-4 text-sm text-text-3">Binary file changed</div>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <div class="bg-surface-1 rounded-lg b-1 b-solid b-surface-3 p-8 text-center text-text-3">
          <span class="i-lucide-check text-2xl mb-2"></span>
          <p>No file changes in this commit</p>
        </div>
      {/if}
    {/if}
  </div>
</div>
