<script lang="ts">
  import { uploadBuffer } from '../lib/blossomStore';

  let dragOver = $state(false);
  let textValue = $state('');

  async function uploadFile(file: File) {
    const buffer = new Uint8Array(await file.arrayBuffer());
    await uploadBuffer(buffer, file.name, file.type || 'application/octet-stream');
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
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

  async function saveText() {
    if (!textValue.trim()) return;
    const data = new TextEncoder().encode(textValue);
    await uploadBuffer(data, 'text.txt', 'text/plain');
  }

  function handleTextKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && textValue.trim()) {
      event.preventDefault();
      void saveText();
    }
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

  <div class="mt-6 relative">
    <textarea
      class="w-full bg-surface-1 text-text-1 rounded-xl p-4 pb-12 min-h-[120px] resize-y border border-surface-3 focus:border-accent focus:outline-none font-mono text-sm"
      placeholder="Paste or write text here..."
      bind:value={textValue}
      onkeydown={handleTextKeydown}
      data-testid="text-input"
    ></textarea>
    <button
      class="btn-primary absolute right-3 bottom-3 text-sm"
      onclick={saveText}
      disabled={!textValue.trim()}
      data-testid="text-save"
    >
      Save
    </button>
  </div>
</section>
