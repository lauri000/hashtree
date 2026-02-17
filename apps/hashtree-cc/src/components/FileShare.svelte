<script lang="ts">
  interface UploadedFile {
    name: string;
    size: number;
    hash: string;
    url: string;
    type: string;
  }

  let dragOver = $state(false);
  let uploading = $state(false);
  let uploadedFiles = $state<UploadedFile[]>([]);
  let copiedHash = $state<string | null>(null);

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function toHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function hashFile(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return toHex(hash);
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    uploading = true;

    for (const file of files) {
      const hash = await hashFile(file);
      const blobUrl = URL.createObjectURL(file);
      uploadedFiles = [...uploadedFiles, {
        name: file.name,
        size: file.size,
        hash,
        url: blobUrl,
        type: file.type,
      }];
    }

    uploading = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    handleFiles(e.dataTransfer?.files ?? null);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  function copyHash(hash: string) {
    navigator.clipboard.writeText(hash);
    copiedHash = hash;
    setTimeout(() => { copiedHash = null; }, 2000);
  }

  function removeFile(hash: string) {
    const file = uploadedFiles.find(f => f.hash === hash);
    if (file) URL.revokeObjectURL(file.url);
    uploadedFiles = uploadedFiles.filter(f => f.hash !== hash);
  }

  function fileIcon(type: string): string {
    if (type.startsWith('image/')) return 'i-lucide-image';
    if (type.startsWith('video/')) return 'i-lucide-video';
    if (type.startsWith('audio/')) return 'i-lucide-music';
    if (type.startsWith('text/')) return 'i-lucide-file-text';
    return 'i-lucide-file';
  }
</script>

<section class="pb-12">
  <label
    class="block border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors {dragOver ? 'border-accent bg-accent/5' : 'border-surface-3'}"
    ondrop={handleDrop}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
  >
    <input
      type="file"
      multiple
      class="hidden"
      onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
    />
    <div class="i-lucide-upload text-4xl text-text-3 mx-auto mb-4"></div>
    {#if uploading}
      <p class="text-text-2">Processing...</p>
    {:else}
      <p class="text-text-1 text-lg font-medium mb-1">Drop files here or click to browse</p>
      <p class="text-text-3 text-sm">Files are hashed locally. Nothing leaves your browser until you share.</p>
    {/if}
  </label>

  {#if uploadedFiles.length > 0}
    <div class="mt-6 space-y-2">
      {#each uploadedFiles as file (file.hash + file.name)}
        <div class="bg-surface-1 rounded-lg p-4 flex items-center gap-4">
          <div class="{fileIcon(file.type)} text-xl text-text-3 shrink-0"></div>
          <div class="flex-1 min-w-0">
            <p class="text-text-1 text-sm font-medium truncate">{file.name}</p>
            <p class="text-text-3 text-xs mt-0.5">{formatSize(file.size)}</p>
            <p class="text-text-3 text-xs mt-0.5 font-mono truncate">sha256: {file.hash}</p>
          </div>
          <div class="flex gap-2 shrink-0">
            <button
              class="btn-ghost text-xs !px-2 !py-1"
              onclick={() => copyHash(file.hash)}
              title="Copy hash"
            >
              {#if copiedHash === file.hash}
                <span class="i-lucide-check text-success"></span>
              {:else}
                <span class="i-lucide-copy"></span>
              {/if}
            </button>
            <button
              class="btn-ghost text-xs !px-2 !py-1"
              onclick={() => removeFile(file.hash)}
              title="Remove"
            >
              <span class="i-lucide-x"></span>
            </button>
          </div>
        </div>
      {/each}
    </div>
    <p class="text-text-3 text-xs mt-4 text-center">
      Blossom upload & WebRTC sharing coming soon.
      For now, use <a href="https://files.iris.to" class="text-accent hover:underline" target="_blank" rel="noopener">files.iris.to</a>
      or the <a href="https://github.com/mmalmi/hashtree" class="text-accent hover:underline" target="_blank" rel="noopener">CLI</a>.
    </p>
  {/if}
</section>
