<script lang="ts">
  import UseCaseCarousel from './UseCaseCarousel.svelte';

  let copiedCmd = $state<string | null>(null);

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    copiedCmd = text;
    setTimeout(() => { copiedCmd = null; }, 2000);
  }

  const installCmd = `curl -fsSL https://github.com/mmalmi/hashtree/releases/latest/download/hashtree-$(uname -m | sed 's/arm64/aarch64/')-$(uname -s | tr '[:upper:]' '[:lower:]' | sed 's/darwin/apple-darwin/' | sed 's/linux/unknown-linux-musl/').tar.gz | tar -xz && cd hashtree && ./install.sh`;
  const cargoCmd = 'cargo install hashtree-cli';
  const cloneCmd = 'git clone htree://npub1dqgr6ds2kdauzpqtvpt2ldc5ca4spemj4n4jnjcvn7496x45gnesls5j6g/hashtree';
  const pushCmd = 'git push htree://self/myrepo master';
  const publicCmd = 'htree://self/myrepo';
  const linkVisibleCmd = 'htree://self/myrepo#link-visible';
  const privateCmd = 'htree://self/myrepo#private';
</script>

<section class="py-12">
  <!-- Content-Addressed Storage -->
  <div class="text-center mb-8">
    <h2 class="text-3xl md:text-4xl font-bold text-text-1 mb-4">
      Content-Addressed Storage
    </h2>
    <p class="text-lg text-text-2 max-w-xl mx-auto mb-6">
      A simple merkle tree for git repos, file sharing, and anything else.
      Sync peer-to-peer between browsers and devices, or via servers.
    </p>
    <div class="flex gap-3 justify-center">
      <a
        href="https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree/rust"
        class="btn-primary inline-flex items-center gap-2 no-underline"
        target="_blank"
        rel="noopener"
      >
        Rust
      </a>
      <a
        href="https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree/ts"
        class="btn-primary inline-flex items-center gap-2 no-underline"
        target="_blank"
        rel="noopener"
      >
        TypeScript
      </a>
    </div>
  </div>

  <div class="grid md:grid-cols-3 gap-4 mb-8">
    <div class="bg-surface-1 rounded-xl p-5">
      <div class="i-lucide-hard-drive text-2xl text-[#60a5fa] mb-3"></div>
      <h3 class="text-text-1 font-semibold mb-2">Content-Addressed</h3>
      <p class="text-text-2 text-sm">
        Files and directories stored as merkle trees, identified by hash.
        Verify integrity automatically. Deduplicate across repos.
      </p>
    </div>
    <div class="bg-surface-1 rounded-xl p-5">
      <div class="i-lucide-lock text-2xl text-[#f59e0b] mb-3"></div>
      <h3 class="text-text-1 font-semibold mb-2">Encrypted by Default</h3>
      <p class="text-text-2 text-sm">
        Content Hash Key (CHK) encryption: the key is the hash of the plaintext.
        Same content always produces the same ciphertext, enabling deduplication even on encrypted data.
      </p>
    </div>
    <div class="bg-surface-1 rounded-xl p-5">
      <div class="i-lucide-link text-2xl text-[#a78bfa] mb-3"></div>
      <h3 class="text-text-1 font-semibold mb-2">Mutable References</h3>
      <p class="text-text-2 text-sm">
        Use <code class="text-accent">npub/path</code> URLs as stable permalinks.
        The latest merkle root is published to Nostr relays, so links always resolve to the current version.
      </p>
    </div>
    <div class="bg-surface-1 rounded-xl p-5">
      <div class="i-lucide-globe text-2xl text-[#34d399] mb-3"></div>
      <h3 class="text-text-1 font-semibold mb-2">Peer-to-Peer</h3>
      <p class="text-text-2 text-sm">
        Share directly between browsers and devices over WebRTC.
        No servers needed.
      </p>
    </div>
    <div class="bg-surface-1 rounded-xl p-5">
      <div class="i-lucide-shield text-2xl text-[#f87171] mb-3"></div>
      <h3 class="text-text-1 font-semibold mb-2">No Gatekeepers</h3>
      <p class="text-text-2 text-sm">
        No DNS, no SSL certificates, no accounts — just a keypair.
        Ideal for autonomous agents and humans alike.
      </p>
    </div>
    <div class="bg-surface-1 rounded-xl p-5">
      <div class="i-lucide-truck text-2xl text-[#38bdf8] mb-3"></div>
      <h3 class="text-text-1 font-semibold mb-2">Multi-Transport</h3>
      <p class="text-text-2 text-sm">
        Works over <a href="https://github.com/hzrd149/blossom" class="text-accent hover:underline" target="_blank" rel="noopener">Blossom</a> servers, WebRTC, HTTP, or any custom transport.
        Mix and match as needed.
      </p>
    </div>
  </div>

  <!-- Use cases carousel -->
  <UseCaseCarousel />

  <!-- Git without GitHub -->
  <div class="text-center mb-8 mt-16">
    <h2 class="text-3xl md:text-4xl font-bold text-text-1 mb-4">
      Git without GitHub
    </h2>
    <p class="text-lg text-text-2 max-w-xl mx-auto">
      Push and pull git repos over content-addressed storage.
      No server required. Sync over Blossom servers, WebRTC, or any transport.
    </p>
  </div>

  <div class="bg-surface-1 rounded-xl p-6 mb-8">
    <h3 class="text-lg font-semibold text-text-1 mb-4">
      <span class="i-lucide-terminal mr-2"></span>
      Quick Start
    </h3>

    <div class="space-y-4">
      <div>
        <p class="text-text-2 text-sm mb-2">1. Install the CLI and git remote helper</p>
        <div class="bg-surface-0 rounded-lg p-3 flex items-start justify-between gap-2 font-mono text-sm">
          <code class="text-accent text-xs break-all whitespace-pre-wrap">{installCmd}</code>
          <button class="shrink-0 text-text-3 hover:text-text-1 transition-colors mt-0.5" onclick={() => copy(installCmd)}>
            {#if copiedCmd === installCmd}
              <span class="i-lucide-check text-success"></span>
            {:else}
              <span class="i-lucide-copy"></span>
            {/if}
          </button>
        </div>
        <p class="text-text-3 text-xs mt-2">Or with Cargo: <code class="text-accent">{cargoCmd}</code></p>
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
        <p class="text-text-3 text-xs mt-2">Outputs a <code class="text-accent">htree://npub.../reponame</code> link you can share with anyone.</p>
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

  <!-- Visibility Modes -->
  <div class="bg-surface-1 rounded-xl p-6 mb-8">
    <h3 class="text-lg font-semibold text-text-1 mb-4">
      <span class="i-lucide-eye mr-2"></span>
      Visibility Modes
    </h3>
    <p class="text-text-2 text-sm mb-4">Control who can read your repos using the URL fragment.</p>

    <div class="space-y-4">
      <div>
        <p class="text-text-2 text-sm mb-1"><strong class="text-text-1">Public</strong> <span class="text-text-3">(default)</span> — anyone with the URL can read</p>
        <div class="bg-surface-0 rounded-lg p-3 flex items-center justify-between gap-2 font-mono text-sm">
          <code class="text-accent truncate">{publicCmd}</code>
          <button class="shrink-0 text-text-3 hover:text-text-1 transition-colors" onclick={() => copy(publicCmd)}>
            {#if copiedCmd === publicCmd}
              <span class="i-lucide-check text-success"></span>
            {:else}
              <span class="i-lucide-copy"></span>
            {/if}
          </button>
        </div>
      </div>

      <div>
        <p class="text-text-2 text-sm mb-1"><strong class="text-text-1">Link-visible</strong> — encrypted, only link holders can read</p>
        <div class="bg-surface-0 rounded-lg p-3 flex items-center justify-between gap-2 font-mono text-sm">
          <code class="text-accent truncate">{linkVisibleCmd}</code>
          <button class="shrink-0 text-text-3 hover:text-text-1 transition-colors" onclick={() => copy(linkVisibleCmd)}>
            {#if copiedCmd === linkVisibleCmd}
              <span class="i-lucide-check text-success"></span>
            {:else}
              <span class="i-lucide-copy"></span>
            {/if}
          </button>
        </div>
      </div>

      <div>
        <p class="text-text-2 text-sm mb-1"><strong class="text-text-1">Private</strong> — encrypted to owner only</p>
        <div class="bg-surface-0 rounded-lg p-3 flex items-center justify-between gap-2 font-mono text-sm">
          <code class="text-accent truncate">{privateCmd}</code>
          <button class="shrink-0 text-text-3 hover:text-text-1 transition-colors" onclick={() => copy(privateCmd)}>
            {#if copiedCmd === privateCmd}
              <span class="i-lucide-check text-success"></span>
            {:else}
              <span class="i-lucide-copy"></span>
            {/if}
          </button>
        </div>
      </div>
    </div>
  </div>

  <div class="bg-surface-1 rounded-xl p-6 mb-8">
    <h3 class="text-lg font-semibold text-text-1 mb-3">
      <span class="i-lucide-git-pull-request mr-2"></span>
      Nostr Pull Requests (NIP-34)
    </h3>
    <p class="text-text-2 text-sm mb-2">
      Open, review, and merge git pull requests over Nostr using NIP-34, directly in the web app.
    </p>
    <p class="text-text-3 text-xs mb-1">
      Spec:
      <a
        href="https://github.com/nostr-protocol/nips/blob/master/34.md"
        class="text-accent hover:underline"
        target="_blank"
        rel="noopener"
      >NIP-34</a>
    </p>
    <p class="text-text-3 text-xs">
      Example:
      <a
        href="https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/iris-client?tab=pulls"
        class="text-accent hover:underline break-all"
        target="_blank"
        rel="noopener"
      >files.iris.to pull requests tab</a>
    </p>
  </div>

  <!-- CLI Commands -->
  <div class="bg-surface-1 rounded-xl p-6 mb-8">
    <h3 class="text-lg font-semibold text-text-1 mb-4">
      <span class="i-lucide-terminal mr-2"></span>
      CLI Commands
    </h3>

    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <tbody>
          <tr class="border-b border-surface-2">
            <td class="py-2 pr-4 font-mono text-accent whitespace-nowrap">htree add &lt;path&gt;</td>
            <td class="py-2 text-text-2">Add a file or directory to hashtree</td>
          </tr>
          <tr class="border-b border-surface-2">
            <td class="py-2 pr-4 font-mono text-accent whitespace-nowrap">htree get &lt;cid&gt;</td>
            <td class="py-2 text-text-2">Download content by CID</td>
          </tr>
          <tr class="border-b border-surface-2">
            <td class="py-2 pr-4 font-mono text-accent whitespace-nowrap">htree cat &lt;cid&gt;</td>
            <td class="py-2 text-text-2">Output file content to stdout</td>
          </tr>
          <tr class="border-b border-surface-2">
            <td class="py-2 pr-4 font-mono text-accent whitespace-nowrap">htree start --daemon</td>
            <td class="py-2 text-text-2">Join the P2P network over WebRTC</td>
          </tr>
          <tr class="border-b border-surface-2">
            <td class="py-2 pr-4 font-mono text-accent whitespace-nowrap">htree status</td>
            <td class="py-2 text-text-2">Show daemon status, peers, and storage</td>
          </tr>
          <tr class="border-b border-surface-2">
            <td class="py-2 pr-4 font-mono text-accent whitespace-nowrap">htree push</td>
            <td class="py-2 text-text-2">Push content to Blossom file servers</td>
          </tr>
          <tr>
            <td class="py-2 pr-4 font-mono text-accent whitespace-nowrap">htree user</td>
            <td class="py-2 text-text-2">Show or set your Nostr identity</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Web Apps -->
  <div class="text-center mb-8 mt-16">
    <h2 class="text-3xl md:text-4xl font-bold text-text-1 mb-4">
      Web Apps
    </h2>
    <p class="text-lg text-text-2 max-w-xl mx-auto mb-6">
      Case Study: <code class="text-accent">hashtree.cc</code>
    </p>
    <div class="flex flex-wrap gap-3 justify-center">
      <a
        href="https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree/apps/hashtree-cc"
        class="btn-primary inline-flex items-center gap-2 no-underline"
        target="_blank"
        rel="noopener"
      >
        <span class="i-lucide-app-window"></span>
        App Source
      </a>
      <a
        href="https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree/ts"
        class="btn-ghost inline-flex items-center gap-2 no-underline"
        target="_blank"
        rel="noopener"
      >
        <span class="i-lucide-code"></span>
        TypeScript Packages
      </a>
    </div>
  </div>

  <div class="bg-surface-1 rounded-xl p-6 mb-8">
    <h3 class="text-lg font-semibold text-text-1 mb-4">
      <span class="i-lucide-box mr-2"></span>
      Package Usage
    </h3>
    <div class="space-y-3 text-xs text-text-3">
      <p>
        <code class="text-accent">@hashtree/core</code>:
        content hash and <code class="text-accent">nhash</code> primitives, plus shared types for content-addressed storage.
      </p>
      <p>
        <code class="text-accent">@hashtree/worker</code>:
        worker API for IndexedDB persistence, Blossom transport, connectivity stats, and service-worker media streaming.
      </p>
      <p>
        <code class="text-accent">@hashtree/worker/p2p</code>:
        WebRTC controller/proxy and signaling helpers for browser-to-browser block transfer.
      </p>
      <p>
        <code class="text-accent">@hashtree/nostr</code>:
        Nostr signaling message types used by the WebRTC sync path.
      </p>
    </div>
  </div>

  <div class="bg-surface-1 rounded-xl p-6 mb-8">
    <h3 class="text-lg font-semibold text-text-1 mb-4">
      <span class="i-lucide-workflow mr-2"></span>
      Data Flow
    </h3>
    <div class="space-y-4">
      <div>
        <p class="text-text-1 text-sm font-medium mb-1">Write path</p>
        <p class="text-text-3 text-xs">
          On upload, encrypted chunks are saved to local IndexedDB first and <code class="text-accent">nhash</code> is returned immediately.
          Upload to configured Blossom write servers continues in the background.
        </p>
      </div>
      <div>
        <p class="text-text-1 text-sm font-medium mb-1">Read path (for nhash/content hash lookups)</p>
        <ol class="text-text-3 text-xs space-y-1 pl-4 list-decimal">
          <li>Check local IndexedDB cache.</li>
          <li>If missing, fetch from Blossom read servers.</li>
          <li>If still missing, ask connected WebRTC peers.</li>
        </ol>
        <p class="text-text-3 text-xs mt-2">
          This order is applied per needed block, and remote hits are cached back to IndexedDB.
        </p>
      </div>
      <div>
        <p class="text-text-1 text-sm font-medium mb-1">Media streaming path</p>
        <p class="text-text-3 text-xs">
          The service worker captures <code class="text-accent">/htree/&lt;nhash&gt;/...</code> requests and forwards them to the hashtree worker.
          The worker serves <code class="text-accent">HEAD</code> and byte-range requests, so video tags like
          <code class="text-accent">src="/htree/&lt;nhash&gt;/video.mp4"</code> can seek efficiently using partial responses.
          Large full downloads also stream chunk-by-chunk, without buffering the entire file in memory.
        </p>
      </div>
    </div>
  </div>

  <div class="bg-surface-1 rounded-xl p-6 mb-8">
    <h3 class="text-lg font-semibold text-text-1 mb-3">
      <span class="i-lucide-radio mr-2"></span>
      WebRTC Signaling (NIP-100)
    </h3>
    <p class="text-text-2 text-sm mb-2">
      Peer-to-peer connections are established via Nostr ephemeral events (kind 25050).
      Peers broadcast presence with <code class="text-accent">#l: "hello"</code> tags for discovery, then exchange WebRTC offers and answers encrypted with NIP-44.
    </p>
    <p class="text-text-3 text-xs">
      Spec:
      <a
        href="https://github.com/nostr-protocol/nips/pull/363"
        class="text-accent hover:underline"
        target="_blank"
        rel="noopener"
      >NIP-100</a>
    </p>
  </div>

  <!-- Links -->
  <div class="flex flex-wrap gap-3 justify-center">
    <a
      href="https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree"
      class="btn-primary inline-flex items-center gap-2 no-underline"
      target="_blank"
      rel="noopener"
    >
      <span class="i-lucide-code"></span>
      Source Code
    </a>
    <a
      href="https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree/docs/HTS-01.md"
      class="btn-ghost inline-flex items-center gap-2 no-underline"
      target="_blank"
      rel="noopener"
    >
      <span class="i-lucide-file-text"></span>
      Protocol Spec
    </a>
  </div>
</section>
