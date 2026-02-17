<script lang="ts">
  import { BlossomStore, nhashEncode, sha256, toHex, fromHex } from '@hashtree/core';
  import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
  import type { BlossomSigner } from '@hashtree/core';
  import { cacheBlob } from '../lib/blobCache';

  const BLOSSOM_SERVERS = [
    { url: 'https://blossom.primal.net', write: true },
    { url: 'https://upload.iris.to', write: true, read: false },
  ];

  let dragOver = $state(false);

  // Generate ephemeral Nostr keypair (in-memory only)
  const secretKey = generateSecretKey();

  const signer: BlossomSigner = async (template) => {
    const event = finalizeEvent({
      ...template,
      kind: template.kind as 24242,
      created_at: template.created_at,
      content: template.content,
      tags: template.tags,
    }, secretKey);
    return {
      kind: event.kind,
      created_at: event.created_at,
      content: event.content,
      tags: event.tags,
      pubkey: event.pubkey,
      id: event.id,
      sig: event.sig,
    };
  };

  const store = new BlossomStore({
    servers: BLOSSOM_SERVERS,
    signer,
  });

  async function uploadFile(file: File) {
    // Hash locally
    const buffer = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256(buffer);
    const hashHex = toHex(hash);
    const nhash = nhashEncode(hashHex);

    // Cache locally so viewer can display immediately
    cacheBlob(hashHex, buffer, file.type || 'application/octet-stream');

    // Navigate to viewer immediately
    window.location.hash = `/${nhash}/${encodeURIComponent(file.name)}`;

    // Upload to Blossom in background (fire-and-forget)
    store.put(fromHex(hashHex), buffer, file.type || 'application/octet-stream').catch(() => {});
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    // Upload first file (navigate to its viewer)
    uploadFile(files[0]);
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
</script>

<section class="pb-12">
  <label
    class="block border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors {dragOver ? 'border-accent bg-accent/5' : 'border-surface-3'}"
    ondrop={handleDrop}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    data-testid="drop-zone"
  >
    <input
      type="file"
      multiple
      class="hidden"
      data-testid="file-input"
      onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
    />
    <div class="i-lucide-upload text-4xl text-text-3 mx-auto mb-4"></div>
    <p class="text-text-1 text-lg font-medium mb-1">Drop files or browse</p>
  </label>
</section>
