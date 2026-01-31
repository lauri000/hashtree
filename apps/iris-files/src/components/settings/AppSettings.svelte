<script lang="ts">
  import { getNsec } from '../../nostr';
  import { isFilesApp } from '../../appType';

  // Secret key
  let nsec = $derived(getNsec());
  let copiedNsec = $state(false);

  async function copySecretKey() {
    const key = getNsec();
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      copiedNsec = true;
      setTimeout(() => (copiedNsec = false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  }
</script>

<div class="p-4 space-y-6 max-w-2xl mx-auto">
  <!-- Account (only show when logged in with nsec) -->
  {#if nsec}
    <div>
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">
        Account
      </h3>
      <div class="bg-surface-2 rounded p-3">
        <button
          onclick={copySecretKey}
          class="btn-ghost flex items-center gap-2 text-sm w-full justify-start"
          data-testid="copy-secret-key"
        >
          {#if copiedNsec}
            <span class="i-lucide-check text-success"></span>
            <span>Copied!</span>
          {:else}
            <span class="i-lucide-key"></span>
            <span>Copy secret key</span>
          {/if}
        </button>
      </div>
    </div>
  {/if}

  <!-- About -->
  <div>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">
      About
    </h3>
    <p class="text-sm text-text-2 mb-3">
      hashtree - Content-addressed filesystem on Nostr
    </p>
    <div class="bg-surface-2 rounded p-3 text-sm space-y-3">
      <div class="flex justify-between items-center">
        <span class="text-muted">Build</span>
        <span class="text-text-1 font-mono text-xs">
          {(() => {
            const buildTime = import.meta.env.VITE_BUILD_TIME;
            if (!buildTime || buildTime === 'undefined') return 'development';
            try {
              return new Date(buildTime).toLocaleString();
            } catch {
              return buildTime;
            }
          })()}
        </span>
      </div>
      <a
        href={isFilesApp() ? "#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree" : "https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree"}
        target={isFilesApp() ? undefined : "_blank"}
        rel={isFilesApp() ? undefined : "noopener noreferrer"}
        class="btn-ghost w-full flex items-center justify-center gap-2 no-underline"
      >
        <span class="i-lucide-code text-sm"></span>
        <span>hashtree</span>
        <span class="text-text-3 text-xs no-underline">(source code)</span>
      </a>
      <button
        onclick={() => window.location.reload()}
        class="btn-ghost w-full flex items-center justify-center gap-2"
      >
        <span class="i-lucide-refresh-cw text-sm"></span>
        <span>Refresh App</span>
      </button>
    </div>
  </div>
</div>
