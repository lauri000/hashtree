<script lang="ts">
  /**
   * DirectoryActions - empty state with upload zone and README display
   * Port of React DirectoryActions component
   */
  import { getTree, decodeAsText } from '../../store';
  import { nostrStore } from '../../nostr';
  import { routeStore, currentDirCidStore, treeRootStore, createTreesStore, directoryEntriesStore, createGitInfoStore, permalinkSnapshotStore } from '../../stores';
  import FolderActions from '../FolderActions.svelte';
  import GitRepoView from '../Git/GitRepoView.svelte';
  import ReadmePanel from './ReadmePanel.svelte';
  import { uploadFiles } from '../../stores/upload';
  import { LinkType, type TreeEntry as HashTreeEntry, type TreeVisibility } from '@hashtree/core';
  import { shouldAssumeGitRepoDuringDetection, supportsGitFeatures } from '../../appType';
  import { findNearestGitRootPath } from '../../utils/gitRoot';
  import { hasAmbiguousEmptyGitRootHint } from '../../utils/gitViewContext';
  import ViewerHeader from './ViewerHeader.svelte';
  import { buildSitesHref, findDirectorySiteEntry } from '../../lib/siteHref';
  import { buildTreeEventPermalink } from '../../lib/treeEventSnapshots';

  let route = $derived($routeStore);
  let permalinkSnapshot = $derived($permalinkSnapshotStore);
  let rootCid = $derived($treeRootStore);
  let rootHash = $derived(rootCid?.hash ?? null);
  let currentDirCid = $derived($currentDirCidStore);
  let currentPath = $derived(route.path);
  let dirEntries = $derived($directoryEntriesStore);
  let entries = $derived(dirEntries.entries);

  let viewedNpub = $derived(route.npub ?? permalinkSnapshot.snapshot?.npub ?? null);
  let currentTreeName = $derived(route.treeName ?? permalinkSnapshot.snapshot?.treeName ?? null);
  let userNpub = $derived($nostrStore.npub);
  let isLoggedIn = $derived($nostrStore.isLoggedIn);

  // Get current tree for visibility info
  let targetNpub = $derived(viewedNpub || userNpub);
  let treesStore = $derived(createTreesStore(targetNpub));
  let trees = $state<Array<{ name: string; visibility?: TreeVisibility }>>([]);

  $effect(() => {
    const store = treesStore;
    const unsub = store.subscribe(value => {
      trees = value;
    });
    return unsub;
  });

  let currentTree = $derived(currentTreeName ? trees.find(t => t.name === currentTreeName) : null);

  let canEdit = $derived(!viewedNpub || viewedNpub === userNpub || !isLoggedIn);

  // Quick check if this looks like a git repo (has .git directory)
  // This allows us to show tabs immediately without waiting for async git info
  let hasGitDir = $derived(entries.some((e: HashTreeEntry) => e.name === '.git' && e.type === LinkType.Dir));

  // Check if we're inside a git repo subdirectory (gitRoot propagated via URL)
  let gitRootFromUrl = $derived(route.params.get('g'));
  let hasAmbiguousGitRootHint = $derived(hasAmbiguousEmptyGitRootHint(gitRootFromUrl, currentPath));
  let routeGitRootHint = $derived(hasAmbiguousGitRootHint ? null : gitRootFromUrl);
  let detectedGitRootPath = $state<string | null>(null);
  let gitRepoDetectionResolved = $state(false);
  const assumeGitRepoDuringDetection = shouldAssumeGitRepoDuringDetection();
  let effectiveGitRootPath = $derived(routeGitRootHint ?? detectedGitRootPath);
  let isInGitRepo = $derived(
    supportsGitFeatures() &&
    (assumeGitRepoDuringDetection || hasGitDir || gitRootFromUrl !== null || effectiveGitRootPath !== null)
  );
  let gitMetadataReady = $derived(
    !supportsGitFeatures() ||
    !assumeGitRepoDuringDetection ||
    hasGitDir ||
    (gitRootFromUrl !== null && !hasAmbiguousGitRootHint) ||
    gitRepoDetectionResolved
  );

  $effect(() => {
    const enabled = supportsGitFeatures();
    const treeCid = rootCid;
    const currentDir = currentDirCid;
    const path = currentPath;
    const explicitGitRoot = routeGitRootHint;
    const currentHasGitDir = hasGitDir;

    if (!enabled) {
      detectedGitRootPath = null;
      gitRepoDetectionResolved = true;
      return;
    }

    if (!treeCid || !currentDir) {
      detectedGitRootPath = null;
      gitRepoDetectionResolved = false;
      return;
    }

    if (explicitGitRoot !== null || currentHasGitDir) {
      detectedGitRootPath = null;
      gitRepoDetectionResolved = true;
      return;
    }

    gitRepoDetectionResolved = false;
    let cancelled = false;
    findNearestGitRootPath(treeCid, path).then((gitRootPath) => {
      if (!cancelled) {
        detectedGitRootPath = gitRootPath;
        gitRepoDetectionResolved = true;
      }
    }).catch(() => {
      if (!cancelled) {
        detectedGitRootPath = null;
        gitRepoDetectionResolved = true;
      }
    });

    return () => { cancelled = true; };
  });

  // Resolve git root CID when it's known.
  // In the git app we render repo layout optimistically, but avoid metadata fetches
  // against the wrong CID until root detection resolves.
  let gitRootCid = $state<typeof currentDirCid>(null);

  $effect(() => {
    if (hasGitDir || (gitMetadataReady && effectiveGitRootPath === null)) {
      // We're at the git root, or detection resolved and current dir is the assumed root.
      gitRootCid = currentDirCid;
    } else if (effectiveGitRootPath !== null && rootCid) {
      // We're in a subdirectory - resolve gitRoot path to get CID
      const tree = getTree();
      const pathParts = effectiveGitRootPath === '' ? [] : effectiveGitRootPath.split('/');

      let cancelled = false;
      (async () => {
        try {
          if (pathParts.length === 0) {
            // Git root is at tree root
            if (!cancelled) gitRootCid = rootCid;
          } else {
            // Resolve path to get git root CID
            const result = await tree.resolvePath(rootCid, pathParts.join('/'));
            if (!cancelled && result) {
              gitRootCid = result.cid;
            }
          }
        } catch {
          // Failed to resolve - fall back to null
          if (!cancelled) gitRootCid = null;
        }
      })();
      return () => { cancelled = true; };
    } else {
      gitRootCid = null;
    }
  });

  // Full git info (branches, etc) - loaded async once metadata CID is ready
  let gitInfoStore = $derived(createGitInfoStore(gitMetadataReady ? gitRootCid : null));
  let gitInfo = $state<{
    isRepo: boolean;
    currentBranch: string | null;
    branches: string[];
    tags: string[];
    tagsByCommit: Record<string, string[]>;
    loading: boolean;
  }>({
    isRepo: false,
    currentBranch: null,
    branches: [],
    tags: [],
    tagsByCommit: {},
    loading: true,
  });

  $effect(() => {
    const store = gitInfoStore;
    const unsub = store.subscribe(value => {
      gitInfo = value;
    });
    return unsub;
  });
  // Show actions if we have a tree OR we're in a tree context (empty tree that hasn't been created yet)
  let hasTreeContext = $derived(rootHash !== null || (route.treeName !== null && canEdit));

  let readmeContent = $state<string | null>(null);
  let isDraggingOver = $state(false);
  let fileInputRef: HTMLInputElement | undefined = $state();

  // Find and load README.md
  $effect(() => {
    readmeContent = null;
    const readmeEntry = entries.find(
      (e: HashTreeEntry) => e.name.toLowerCase() === 'readme.md' && e.type !== LinkType.Dir
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

  function openFilePicker() {
    fileInputRef?.click();
  }

  async function handleFileInputChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (files && files.length > 0) {
      await uploadFiles(files);
    }
    // Reset input so same file can be selected again
    input.value = '';
  }

  // Handle external file drop
  async function handleFileDrop(e: DragEvent) {
    e.preventDefault();
    isDraggingOver = false;
    if (!canEdit) return;

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await uploadFiles(files);
    }
  }

  function handleFileDragOver(e: DragEvent) {
    if (!canEdit) return;
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      isDraggingOver = true;
    }
  }

  function handleFileDragLeave(e: DragEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      isDraggingOver = false;
    }
  }

  // Check if should hide actions (locked link-visible/private)
  let hideActions = $derived(
    rootCid?.hash && !rootCid?.key && currentTree &&
    (currentTree.visibility === 'link-visible' || currentTree.visibility === 'private')
  );

  // Build back URL (parent directory or tree list)
  let backUrl = $derived.by(() => {
    if (route.isPermalink && route.params.get('snapshot') === '1' && permalinkSnapshot.snapshot) {
      if (currentPath.length > 0) {
        return buildTreeEventPermalink(permalinkSnapshot.snapshot, currentPath.slice(0, -1), route.params.get('k'));
      }
      return viewedNpub ? `#/${encodeURIComponent(viewedNpub)}` : '#/';
    }
    const parts: string[] = [];
    if (route.npub && route.treeName) {
      // In a tree - go to parent dir or tree list
      if (currentPath.length > 0) {
        // In a subdirectory - go to parent
        parts.push(route.npub, route.treeName, ...currentPath.slice(0, -1));
      } else {
        // At tree root - go to tree list
        parts.push(route.npub);
      }
    }
    const linkKeySuffix = route.params.get('k') ? `?k=${route.params.get('k')}` : '';
    return '#/' + parts.map(encodeURIComponent).join('/') + linkKeySuffix;
  });

  // Get current directory name
  let currentDirName = $derived.by(() => {
    if (currentPath.length > 0) {
      return currentPath[currentPath.length - 1];
    }
    return currentTreeName || '';
  });

  let siteEntryName = $derived(findDirectorySiteEntry(entries.filter((entry) => entry.type !== LinkType.Dir)));
  let openSiteHref = $derived.by(() => {
    if (!siteEntryName || !currentDirCid) return '';
    return buildSitesHref({
      route,
      siteRootCid: currentDirCid,
      siteRootPath: currentPath,
      entryPath: siteEntryName,
      autoReloadMutable: true,
    });
  });

</script>

<!-- If this is a git repo or inside one (via gitRoot URL param), show GitHub-style directory listing -->
{#if isInGitRepo && currentDirCid}
  <div class="flex flex-col h-full">
    <div class="flex-1 overflow-auto">
      <GitRepoView
        dirCid={currentDirCid}
        {gitRootCid}
        gitRootPath={effectiveGitRootPath}
        loadGitMetadata={gitMetadataReady}
        {entries}
        {canEdit}
        currentBranch={gitInfo.currentBranch}
        branches={gitInfo.branches}
        tags={gitInfo.tags}
        tagsByCommit={gitInfo.tagsByCommit}
        {backUrl}
        npub={viewedNpub}
        isPermalink={route.isPermalink}
        {rootCid}
        visibility={currentTree?.visibility}
      />
    </div>
  </div>
{:else}
  <div
    class="flex flex-col h-full"
    role="region"
    aria-label="Directory content"
    ondragover={handleFileDragOver}
    ondragleave={handleFileDragLeave}
    ondrop={handleFileDrop}
  >
    <!-- Header with back button, avatar, visibility, folder name -->
    <ViewerHeader
      {backUrl}
      npub={viewedNpub}
      isPermalink={route.isPermalink}
      {rootCid}
      visibility={currentTree?.visibility}
      icon="i-lucide-folder-open text-warning"
      name={currentDirName}
    >
      {#snippet actions()}
        {#if openSiteHref}
          <a
            href={openSiteHref}
            target="_blank"
            rel="noreferrer"
            class="btn-ghost no-underline"
            data-testid="directory-open-site"
          >
            Open Site
          </a>
        {/if}
      {/snippet}
    </ViewerHeader>
    <!-- Action buttons - hide when viewing locked link-visible/private directory -->
    {#if hasTreeContext && !hideActions}
      <div class="p-3 shrink-0">
        <FolderActions dirCid={currentDirCid} {canEdit} />
      </div>
    {/if}

  <!-- Upload drop zone -->
  {#if hasTreeContext && canEdit && !readmeContent}
    <div
      class="flex-1 mx-3 mb-3 flex items-center justify-center cursor-pointer transition-colors border border-surface-3 rounded-lg {isDraggingOver ? 'bg-surface-1/50' : 'hover:bg-surface-1/50'}"
      onclick={openFilePicker}
      role="button"
      tabindex="0"
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') openFilePicker(); }}
    >
      <div class="flex flex-col items-center text-text-3">
        <span class="i-lucide-plus text-4xl mb-2"></span>
        <span class="text-sm">Drop or click to add</span>
      </div>
      <input
        bind:this={fileInputRef}
        type="file"
        multiple
        class="hidden"
        onchange={handleFileInputChange}
      />
    </div>
  {/if}

  <!-- README.md content -->
  {#if readmeContent}
    <div class="flex-1 overflow-auto px-3 pb-3">
      <ReadmePanel content={readmeContent} {entries} {canEdit} />
    </div>
  {/if}
  </div>
{/if}
