<script lang="ts">
  /**
   * CommitFileView - Shows a single file as it existed in a specific commit.
   */
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { getTree, decodeAsText, formatBytes } from '../../store';
  import { getFileAtCommit } from '../../utils/git';
  import { getErrorMessage } from '../../utils/errorMessage';
  import { routeStore, treeRootStore, createTreesStore } from '../../stores';
  import { findNearestGitRootPath } from '../../utils/gitRoot';
  import { hasAmbiguousEmptyGitRootHint } from '../../utils/gitViewContext';
  import ViewerHeader from '../Viewer/ViewerHeader.svelte';
  import RepoTabNav from './RepoTabNav.svelte';
  import CodeViewer from '../Viewer/CodeViewer.svelte';
  import MarkdownViewer from '../Viewer/MarkdownViewer.svelte';
  import HtmlViewer from '../Viewer/HtmlViewer.svelte';

  interface Props {
    npub: string;
    commitHash: string;
  }

  let { npub, commitHash }: Props = $props();

  let route = $derived($routeStore);
  let rootCid = $derived($treeRootStore);
  let gitRootCid = $state<typeof rootCid>(null);

  let treesStore = $derived(createTreesStore(npub));
  let trees = $state<Array<{ name: string; visibility?: string }>>([]);

  $effect(() => {
    const store = treesStore;
    const unsub = store.subscribe(value => {
      trees = value;
    });
    return unsub;
  });

  let gitRootPath = $derived(route.params.get('g'));
  let detectedGitRootPath = $state<string | null>(null);
  let hasAmbiguousGitRootHint = $derived(hasAmbiguousEmptyGitRootHint(gitRootPath, route.path.slice(0, -1)));
  let routeGitRootHint = $derived(hasAmbiguousGitRootHint ? null : gitRootPath);
  let effectiveGitRootPath = $derived(routeGitRootHint ?? detectedGitRootPath);
  let repoRootParts = $derived.by(() => {
    if (effectiveGitRootPath !== null) {
      return effectiveGitRootPath === '' ? [] : effectiveGitRootPath.split('/');
    }
    return [];
  });
  let repoName = $derived.by(() => {
    if (!route.treeName) return '';
    return repoRootParts.length > 0 ? `${route.treeName}/${repoRootParts.join('/')}` : route.treeName;
  });
  let currentTree = $derived(trees.find(t => t.name === route.treeName));
  let fileName = $derived(route.path[route.path.length - 1] ?? 'File');
  let filePath = $derived.by(() => {
    const relativeParts = route.path.slice(repoRootParts.length);
    return relativeParts.join('/');
  });

  let loading = $state(true);
  let error = $state<string | null>(null);
  let fileData = $state<Uint8Array | null>(null);
  let fileContent = $state<string | null>(null);
  let objectUrl = $state<string | null>(null);

  $effect(() => {
    const explicitGitRoot = routeGitRootHint;
    const treeCid = rootCid;
    const path = route.path.slice(0, -1);

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

    if (!treeCid) {
      gitRootCid = null;
      return;
    }

    if (explicitGitRoot === null || explicitGitRoot === '') {
      gitRootCid = treeCid;
      return;
    }

    let cancelled = false;
    getTree().resolvePath(treeCid, explicitGitRoot).then((resolved) => {
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
    if (!gitRootCid || !filePath || !commitHash) return;

    loading = true;
    error = null;
    fileData = null;
    fileContent = null;

    let cancelled = false;

    (async () => {
      try {
        const data = await getFileAtCommit(gitRootCid, filePath, commitHash);
        if (cancelled) return;

        if (!data) {
          error = `${filePath} not found in commit ${commitHash}`;
          loading = false;
          return;
        }

        fileData = data;
        fileContent = decodeAsText(data);
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

  $effect(() => {
    const data = fileData;
    const mimeType = getMimeType(fileName);
    if (!data || !mimeType) {
      objectUrl = null;
      return;
    }

    const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
    objectUrl = url;
    return () => {
      URL.revokeObjectURL(url);
      if (objectUrl === url) {
        objectUrl = null;
      }
    };
  });

  function getMimeType(filename?: string): string | null {
    if (!filename) return null;
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      avif: 'image/avif',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      bmp: 'image/bmp',
      pdf: 'application/pdf',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      flac: 'audio/flac',
      m4a: 'audio/mp4',
      ogg: 'audio/ogg',
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      avi: 'video/x-msvideo',
      mkv: 'video/x-matroska',
    };
    return ext ? mimeTypes[ext] || null : null;
  }

  function isMarkdownFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return ext === 'md' || ext === 'markdown';
  }

  function isHtmlFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return ext === 'html' || ext === 'htm';
  }

  function isImageFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'].includes(ext);
  }

  function isAudioFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'].includes(ext);
  }

  function isVideoFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return ['mp4', 'webm', 'ogg', 'ogv', 'mov', 'avi', 'mkv'].includes(ext);
  }

  function isPdfFile(filename: string): boolean {
    return filename.split('.').pop()?.toLowerCase() === 'pdf';
  }

  let isMarkdown = $derived(isMarkdownFile(fileName));
  let isHtml = $derived(isHtmlFile(fileName));
  let isImage = $derived(isImageFile(fileName));
  let isAudio = $derived(isAudioFile(fileName));
  let isVideo = $derived(isVideoFile(fileName));
  let isPdf = $derived(isPdfFile(fileName));

  let commitUrl = $derived.by(() => {
    const params = new SvelteURLSearchParams();
    params.set('commit', commitHash);
    if (route.params.get('k')) params.set('k', route.params.get('k')!);
    params.set('g', effectiveGitRootPath ?? '');
    return `#/${npub}/${repoName}?${params.toString()}`;
  });

  function handleDownload() {
    if (!fileData) return;
    const mimeType = getMimeType(fileName) || 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([fileData], { type: mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
</script>

<div class="flex flex-1 flex-col min-w-0 min-h-0 bg-surface-0" data-testid="commit-file-view">
  <ViewerHeader
    backUrl={commitUrl}
    {npub}
    {rootCid}
    visibility={currentTree?.visibility}
    icon="i-lucide-file-text text-accent"
    name={fileName}
  />

  <RepoTabNav {npub} {repoName} activeTab="code" />

  <div class="shrink-0 px-4 py-2 bg-surface-1 b-b-1 b-b-solid b-b-surface-3 flex flex-wrap items-center gap-3">
    <code class="text-xs bg-surface-2 px-2 py-1 rounded font-mono">{commitHash.slice(0, 7)}</code>
    <span class="text-sm font-mono text-text-2 truncate">{filePath}</span>
    <a href={commitUrl} class="btn-ghost no-underline text-sm">Back to commit</a>
    <button onclick={handleDownload} class="btn-ghost text-sm" disabled={!fileData}>Download</button>
  </div>

  <div class="flex-1 overflow-auto">
    {#if loading}
      <div class="flex items-center justify-center py-12 text-text-3">
        <span class="i-lucide-loader-2 animate-spin mr-2"></span>
        Loading file...
      </div>
    {:else if error}
      <div class="flex flex-col items-center justify-center py-12 text-danger">
        <span class="i-lucide-alert-circle text-2xl mb-2"></span>
        <span>{error}</span>
      </div>
    {:else if isVideo && objectUrl}
      <div class="p-4">
        <video class="max-w-full rounded-lg" controls src={objectUrl}>
          <track kind="captions" label="Captions unavailable" srclang="en" />
        </video>
      </div>
    {:else if isAudio && objectUrl}
      <div class="p-4">
        <audio class="w-full" controls src={objectUrl}></audio>
      </div>
    {:else if isImage && objectUrl}
      <div class="p-4 flex items-center justify-center">
        <img src={objectUrl} alt={fileName} class="max-w-full rounded-lg" />
      </div>
    {:else if isPdf && objectUrl}
      <iframe src={objectUrl} class="w-full h-full border-none" title={fileName}></iframe>
    {:else if isMarkdown && fileContent !== null}
      <div class="h-full overflow-auto">
        <MarkdownViewer content={fileContent} />
      </div>
    {:else if isHtml && fileContent !== null}
      <HtmlViewer content={fileContent} fileName={fileName} />
    {:else if fileContent !== null}
      <CodeViewer content={fileContent} filename={fileName} />
    {:else if fileData}
      <div class="h-full flex items-center justify-center p-6">
        <div class="text-center text-text-2">
          <div class="i-lucide-file text-3xl mb-3 mx-auto"></div>
          <div class="font-medium mb-1">{fileName}</div>
          <div class="text-sm text-text-3">{formatBytes(fileData.length)}</div>
          <div class="text-sm text-text-3 mt-2">Binary file preview unavailable</div>
        </div>
      </div>
    {/if}
  </div>
</div>
