<script lang="ts">
  import { nhashDecode, toHex } from '@hashtree/core';
  import { getCachedBlob } from '../lib/blobCache';

  interface Props {
    nhash: string;
    fileName: string;
  }

  let { nhash, fileName }: Props = $props();

  const BLOSSOM_SERVERS = [
    'https://blossom.primal.net',
    'https://upload.iris.to',
  ];

  let status = $state<'loading' | 'loaded' | 'error'>('loading');
  let error = $state('');
  let blobUrl = $state('');
  let textContent = $state('');
  let copiedLink = $state(false);

  const ext = $derived(fileName.split('.').pop()?.toLowerCase() ?? '');
  const isImage = $derived(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'].includes(ext));
  const isVideo = $derived(['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'].includes(ext));
  const isAudio = $derived(['mp3', 'wav', 'flac', 'm4a', 'aac', 'opus'].includes(ext));
  const isText = $derived(['txt', 'md', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts', 'py', 'rs', 'go', 'sh', 'toml', 'yaml', 'yml', 'log', 'ini', 'cfg', 'conf', 'env', 'svelte', 'jsx', 'tsx'].includes(ext));
  const isPdf = $derived(ext === 'pdf');

  const shareUrl = $derived(`${window.location.origin}/#/${nhash}/${encodeURIComponent(fileName)}`);

  function copyLink() {
    navigator.clipboard.writeText(shareUrl);
    copiedLink = true;
    setTimeout(() => { copiedLink = false; }, 2000);
  }

  function loadFromData(data: ArrayBuffer) {
    if (isText) {
      textContent = new TextDecoder().decode(data);
    } else {
      const mimeType = getMimeType();
      const blob = new Blob([data], mimeType ? { type: mimeType } : undefined);
      blobUrl = URL.createObjectURL(blob);
    }
    status = 'loaded';
  }

  async function fetchBlob() {
    const cid = nhashDecode(nhash);
    const hashHex = toHex(cid.hash);

    // Check local cache first (just-uploaded files)
    const cached = getCachedBlob(hashHex);
    if (cached) {
      loadFromData(cached.data);
      return;
    }

    // Fetch from Blossom servers
    for (const server of BLOSSOM_SERVERS) {
      try {
        const res = await fetch(`${server}/${hashHex}`);
        if (res.ok) {
          loadFromData(await res.arrayBuffer());
          return;
        }
      } catch {
        continue;
      }
    }

    error = 'File not found on any server';
    status = 'error';
  }

  function getMimeType(): string | undefined {
    if (isImage) {
      const map: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif' };
      return map[ext] ?? `image/${ext}`;
    }
    if (isVideo) {
      const map: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska' };
      return map[ext];
    }
    if (isAudio) {
      const map: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus' };
      return map[ext];
    }
    if (isPdf) return 'application/pdf';
    return undefined;
  }

  function download() {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    a.click();
  }

  // Fetch once on mount (nhash/fileName are immutable props from routing)
  fetchBlob();
</script>

<div class="py-8" data-testid="file-viewer">
  <div class="mb-4 flex items-center justify-between gap-4">
    <div class="min-w-0">
      <h2 class="text-text-1 text-lg font-medium truncate">{decodeURIComponent(fileName)}</h2>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <button class="btn-ghost text-sm" onclick={copyLink} title="Copy link">
        {#if copiedLink}
          <span class="i-lucide-check text-success mr-1"></span> Copied
        {:else}
          <span class="i-lucide-link mr-1"></span> Copy Link
        {/if}
      </button>
      <a href="/" class="btn-ghost text-sm" onclick={() => history.pushState(null, '', '/')}>
        <span class="i-lucide-arrow-left mr-1"></span>
        Back
      </a>
    </div>
  </div>

  {#if status === 'loading'}
    <div class="flex items-center justify-center py-20">
      <span class="i-lucide-loader text-2xl text-text-3 animate-spin"></span>
    </div>
  {:else if status === 'error'}
    <div class="bg-surface-1 rounded-xl p-8 text-center">
      <div class="i-lucide-alert-circle text-3xl text-danger mx-auto mb-3"></div>
      <p class="text-text-2">{error}</p>
    </div>
  {:else if isImage}
    <div class="flex justify-center">
      <img src={blobUrl} alt={fileName} class="max-w-full max-h-[80vh] rounded-lg" data-testid="viewer-image" />
    </div>
  {:else if isVideo}
    <video src={blobUrl} controls class="max-w-full max-h-[80vh] mx-auto rounded-lg" data-testid="viewer-video">
      <track kind="captions" />
    </video>
  {:else if isAudio}
    <div class="bg-surface-1 rounded-xl p-8 flex flex-col items-center gap-4">
      <div class="i-lucide-music text-4xl text-accent"></div>
      <audio src={blobUrl} controls class="w-full max-w-md" data-testid="viewer-audio"></audio>
    </div>
  {:else if isPdf}
    <iframe src={blobUrl} title={fileName} class="w-full h-[80vh] rounded-lg border border-surface-3" data-testid="viewer-pdf"></iframe>
  {:else if isText}
    <pre class="bg-surface-1 rounded-xl p-6 text-text-1 text-sm overflow-auto max-h-[80vh] whitespace-pre-wrap" data-testid="viewer-text">{textContent}</pre>
  {:else}
    <div class="bg-surface-1 rounded-xl p-8 text-center" data-testid="viewer-download">
      <div class="i-lucide-file text-4xl text-text-3 mx-auto mb-4"></div>
      <p class="text-text-1 font-medium mb-2">{decodeURIComponent(fileName)}</p>
      <button class="btn-primary" onclick={download}>
        <span class="i-lucide-download mr-2"></span>
        Download
      </button>
    </div>
  {/if}
</div>
