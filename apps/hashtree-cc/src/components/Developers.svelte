<script lang="ts">
  let copiedCmd = $state<string | null>(null);

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    copiedCmd = text;
    setTimeout(() => { copiedCmd = null; }, 2000);
  }

  const installCmd = 'cargo install hashtree-cli';
  const cloneCmd = 'git clone htree://npub1.../myrepo';
  const pushCmd = 'git push htree://self/myrepo master';
</script>

<section class="py-12">
  <div class="text-center mb-12">
    <h2 class="text-3xl md:text-4xl font-bold text-text-1 mb-4">
      Git without GitHub
    </h2>
    <p class="text-lg text-text-2 max-w-xl mx-auto">
      Push and pull git repos over content-addressed storage.
      No server required. Sync over Nostr relays, Blossom servers, or USB drives.
    </p>
  </div>

  <!-- Demo section -->
  <div class="bg-surface-1 rounded-xl p-6 mb-8">
    <h3 class="text-lg font-semibold text-text-1 mb-4">
      <span class="i-lucide-terminal mr-2"></span>
      Quick Start
    </h3>

    <div class="space-y-4">
      <div>
        <p class="text-text-2 text-sm mb-2">1. Install the CLI</p>
        <div class="bg-surface-0 rounded-lg p-3 flex items-center justify-between gap-2 font-mono text-sm">
          <code class="text-accent truncate">{installCmd}</code>
          <button class="shrink-0 text-text-3 hover:text-text-1 transition-colors" onclick={() => copy(installCmd)}>
            {#if copiedCmd === installCmd}
              <span class="i-lucide-check text-success"></span>
            {:else}
              <span class="i-lucide-copy"></span>
            {/if}
          </button>
        </div>
      </div>

      <div>
        <p class="text-text-2 text-sm mb-2">2. Push a repo</p>
        <div class="bg-surface-0 rounded-lg p-3 flex items-center justify-between gap-2 font-mono text-sm">
          <code class="text-accent truncate">{pushCmd}</code>
          <button class="shrink-0 text-text-3 hover:text-text-1 transition-colors" onclick={() => copy(pushCmd)}>
            {#if copiedCmd === pushCmd}
              <span class="i-lucide-check text-success"></span>
            {:else}
              <span class="i-lucide-copy"></span>
            {/if}
          </button>
        </div>
      </div>

      <div>
        <p class="text-text-2 text-sm mb-2">3. Clone from anyone</p>
        <div class="bg-surface-0 rounded-lg p-3 flex items-center justify-between gap-2 font-mono text-sm">
          <code class="text-accent truncate">{cloneCmd}</code>
          <button class="shrink-0 text-text-3 hover:text-text-1 transition-colors" onclick={() => copy(cloneCmd)}>
            {#if copiedCmd === cloneCmd}
              <span class="i-lucide-check text-success"></span>
            {:else}
              <span class="i-lucide-copy"></span>
            {/if}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Features grid -->
  <div class="grid md:grid-cols-3 gap-4 mb-8">
    <div class="bg-surface-1 rounded-xl p-5">
      <div class="i-lucide-hard-drive text-2xl text-accent mb-3"></div>
      <h3 class="text-text-1 font-semibold mb-2">Content-Addressed</h3>
      <p class="text-text-2 text-sm">
        Data is identified by its hash, not by location.
        Verify integrity automatically. Deduplicate across repos.
      </p>
    </div>
    <div class="bg-surface-1 rounded-xl p-5">
      <div class="i-lucide-globe text-2xl text-accent mb-3"></div>
      <h3 class="text-text-1 font-semibold mb-2">Transport Agnostic</h3>
      <p class="text-text-2 text-sm">
        Sync over Nostr relays, Blossom servers, WebRTC, HTTP, USB drives, or any custom transport.
      </p>
    </div>
    <div class="bg-surface-1 rounded-xl p-5">
      <div class="i-lucide-shield text-2xl text-accent mb-3"></div>
      <h3 class="text-text-1 font-semibold mb-2">No Gatekeepers</h3>
      <p class="text-text-2 text-sm">
        No DNS, no SSL certificates, no accounts.
        Identity is a Nostr keypair. You own your data.
      </p>
    </div>
  </div>

  <!-- Use cases -->
  <div class="bg-surface-1 rounded-xl p-6 mb-8">
    <h3 class="text-lg font-semibold text-text-1 mb-4">
      <span class="i-lucide-package mr-2"></span>
      What can you do with it?
    </h3>
    <div class="grid md:grid-cols-2 gap-4">
      <div class="flex gap-3">
        <div class="i-lucide-git-branch text-lg text-accent shrink-0 mt-0.5"></div>
        <div>
          <p class="text-text-1 text-sm font-medium">Decentralized Git</p>
          <p class="text-text-3 text-xs">Push/pull repos using <code class="text-accent">htree://</code> URLs. Works as a git remote helper.</p>
        </div>
      </div>
      <div class="flex gap-3">
        <div class="i-lucide-upload text-lg text-accent shrink-0 mt-0.5"></div>
        <div>
          <p class="text-text-1 text-sm font-medium">File Sharing</p>
          <p class="text-text-3 text-xs">Upload files and share via content hash. Recipients verify integrity automatically.</p>
        </div>
      </div>
      <div class="flex gap-3">
        <div class="i-lucide-zap text-lg text-accent shrink-0 mt-0.5"></div>
        <div>
          <p class="text-text-1 text-sm font-medium">Blossom Integration</p>
          <p class="text-text-3 text-xs">Store and retrieve blobs from any Blossom-compatible server.</p>
        </div>
      </div>
      <div class="flex gap-3">
        <div class="i-lucide-folder text-lg text-accent shrink-0 mt-0.5"></div>
        <div>
          <p class="text-text-1 text-sm font-medium">Iris Files</p>
          <p class="text-text-3 text-xs">Full-featured file manager at <a href="https://files.iris.to" class="text-accent hover:underline" target="_blank" rel="noopener">files.iris.to</a>.</p>
        </div>
      </div>
    </div>
  </div>

  <!-- Links -->
  <div class="flex flex-wrap gap-3 justify-center">
    <a
      href="https://github.com/mmalmi/hashtree"
      class="btn-primary inline-flex items-center gap-2 no-underline"
      target="_blank"
      rel="noopener"
    >
      <span class="i-lucide-code"></span>
      Source Code
    </a>
    <a
      href="https://github.com/mmalmi/hashtree/releases"
      class="btn-ghost inline-flex items-center gap-2 no-underline"
      target="_blank"
      rel="noopener"
    >
      <span class="i-lucide-download"></span>
      Releases
    </a>
    <a
      href="https://files.iris.to"
      class="btn-ghost inline-flex items-center gap-2 no-underline"
      target="_blank"
      rel="noopener"
    >
      <span class="i-lucide-folder"></span>
      Iris Files
    </a>
  </div>
</section>
