<script lang="ts" module>
  let show = $state(false);
  let url = $state('');

  export function open(shareUrl: string): void {
    url = shareUrl.trim();
    show = Boolean(url);
  }

  export function close(): void {
    show = false;
    url = '';
  }
</script>

<script lang="ts">
  import QRCode from 'qrcode';

  let qrDataUrl = $state<string | null>(null);
  let copyStatus = $state<'idle' | 'copied' | 'ready'>('idle');
  let copyStatusTimeoutId = 0;

  $effect(() => {
    if (!show || !url) {
      qrDataUrl = null;
      copyStatus = 'idle';
      if (copyStatusTimeoutId && typeof window !== 'undefined') {
        window.clearTimeout(copyStatusTimeoutId);
        copyStatusTimeoutId = 0;
      }
      return;
    }

    let cancelled = false;

    QRCode.toDataURL(url, {
      width: 240,
      margin: 2,
      color: { dark: '#050507', light: '#ffffff' },
    })
      .then((nextDataUrl) => {
        if (!cancelled) {
          qrDataUrl = nextDataUrl;
        }
      })
      .catch((error) => {
        console.error('[iris-sites] Failed to generate share QR code', error);
        if (!cancelled) {
          qrDataUrl = null;
        }
      });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (!show || typeof document === 'undefined') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        (document.activeElement as HTMLElement | null)?.blur();
        close();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  });

  function resetCopyStatusSoon(): void {
    if (typeof window === 'undefined') return;
    if (copyStatusTimeoutId) {
      window.clearTimeout(copyStatusTimeoutId);
    }
    copyStatusTimeoutId = window.setTimeout(() => {
      copyStatus = 'idle';
      copyStatusTimeoutId = 0;
    }, 1800);
  }

  async function copyUrl(): Promise<void> {
    if (!url || typeof window === 'undefined') return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        throw new Error('Clipboard API unavailable');
      }
      copyStatus = 'copied';
    } catch {
      window.prompt('Copy share URL', url);
      copyStatus = 'ready';
    }

    resetCopyStatusSoon();
  }

  async function handleNativeShare(): Promise<void> {
    if (!url || typeof navigator === 'undefined' || !('share' in navigator)) return;

    try {
      await navigator.share({ url });
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('[iris-sites] Share failed', error);
      }
    }
  }

  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      close();
    }
  }
</script>

{#if show && url}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="share-modal-backdrop"
    onclick={handleBackdropClick}
    data-testid="share-modal-backdrop"
  >
    <dialog
      class="share-modal-card"
      open
      aria-label="Share this site"
      data-testid="share-modal"
    >
      <div class="share-modal-header">
        <p class="share-modal-eyebrow">Share</p>
        <button class="share-modal-close" type="button" aria-label="Close share dialog" onclick={close}>
          Close
        </button>
      </div>

      <button class="share-modal-qr-button" type="button" onclick={close}>
        {#if qrDataUrl}
          <img
            src={qrDataUrl}
            alt="QR Code"
            class="share-modal-qr-image"
            data-testid="share-qr-code"
          />
        {:else}
          <div class="share-modal-qr-loading" aria-label="Generating QR code">
            <div class="share-modal-spinner"></div>
          </div>
        {/if}
      </button>

      <div class="share-modal-url-panel">
        <p class="share-modal-url-label">Launcher URL</p>
        <div class="share-modal-url-text">{url}</div>
        <button class="share-modal-copy-button" type="button" onclick={copyUrl} data-state={copyStatus}>
          {copyStatus === 'idle' ? 'Copy URL' : copyStatus === 'copied' ? 'Copied' : 'Ready'}
        </button>
      </div>

      {#if typeof navigator !== 'undefined' && 'share' in navigator}
        <button class="share-modal-native-button" type="button" onclick={handleNativeShare}>
          Share via…
        </button>
      {/if}
    </dialog>
  </div>
{/if}

<style>
  .share-modal-backdrop {
    --share-modal-backdrop-background: #09111a;
    --share-modal-card-background: #111926;
    --share-modal-card-background-top: #182537;
    --share-modal-card-border: #304256;
    --share-modal-card-shadow: rgba(0, 0, 0, 0.34);
    --share-modal-panel-background: #0d1520;
    --share-modal-panel-border: #27384c;
    --share-modal-text: #f3f3f4;
    --share-modal-muted-text: #aab6c7;
    --share-modal-link-text: #a8d1ff;
    --share-modal-button-background: #152131;
    --share-modal-button-background-hover: #1b2a3d;
    --share-modal-button-border: #31435a;
    --share-modal-eyebrow: #8de1c0;
    --share-modal-copy-success-text: #0a2c1f;
    --share-modal-copy-success-border: #76d6ad;
    --share-modal-copy-success-background: #c8f2de;
    --share-modal-copy-ready-text: #5f4100;
    --share-modal-copy-ready-border: #f0c35a;
    --share-modal-copy-ready-background: #ffe8af;
    --share-modal-loading-background-start: #ffffff;
    --share-modal-loading-background-end: #e8edf3;
    --share-modal-loading-spinner-track: rgba(17, 25, 38, 0.12);
    --share-modal-loading-spinner-head: rgba(17, 25, 38, 0.78);
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 20px;
    background: var(--share-modal-backdrop-background);
  }

  .share-modal-card {
    margin: 0;
    position: relative;
    inset: auto;
    align-self: center;
    justify-self: center;
    width: min(420px, calc(100vw - 24px));
    max-height: calc(100vh - 40px);
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 18px;
    overflow: auto;
    border-radius: 24px;
    border: 1px solid var(--share-modal-card-border);
    background: linear-gradient(180deg, var(--share-modal-card-background-top) 0%, var(--share-modal-card-background) 100%);
    color: var(--share-modal-text);
    box-shadow: 0 28px 80px var(--share-modal-card-shadow);
  }

  .share-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .share-modal-eyebrow {
    margin: 0;
    font-size: 0.72rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--share-modal-eyebrow);
  }

  .share-modal-close,
  .share-modal-copy-button,
  .share-modal-native-button {
    border: 1px solid var(--share-modal-button-border);
    border-radius: 12px;
    background: var(--share-modal-button-background);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .share-modal-close {
    padding: 10px 12px;
    white-space: nowrap;
  }

  .share-modal-qr-button {
    border: 0;
    padding: 0;
    border-radius: 18px;
    overflow: hidden;
    background: #ffffff;
    cursor: pointer;
  }

  .share-modal-qr-image,
  .share-modal-qr-loading {
    display: block;
    width: 100%;
    aspect-ratio: 1;
  }

  .share-modal-qr-loading {
    display: grid;
    place-items: center;
    background: linear-gradient(180deg, var(--share-modal-loading-background-start) 0%, var(--share-modal-loading-background-end) 100%);
  }

  .share-modal-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--share-modal-loading-spinner-track);
    border-top-color: var(--share-modal-loading-spinner-head);
    border-radius: 999px;
    animation: share-modal-spin 720ms linear infinite;
  }

  .share-modal-url-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border-radius: 18px;
    background: var(--share-modal-panel-background);
    border: 1px solid var(--share-modal-panel-border);
  }

  .share-modal-url-label {
    margin: 0;
    font-size: 0.76rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--share-modal-muted-text);
  }

  .share-modal-url-text {
    font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--share-modal-link-text);
    word-break: break-all;
  }

  .share-modal-copy-button,
  .share-modal-native-button {
    width: 100%;
    padding: 11px 14px;
  }

  .share-modal-copy-button[data-state="copied"] {
    color: var(--share-modal-copy-success-text);
    border-color: var(--share-modal-copy-success-border);
    background: var(--share-modal-copy-success-background);
  }

  .share-modal-copy-button[data-state="ready"] {
    color: var(--share-modal-copy-ready-text);
    border-color: var(--share-modal-copy-ready-border);
    background: var(--share-modal-copy-ready-background);
  }

  .share-modal-close:hover,
  .share-modal-copy-button:hover,
  .share-modal-native-button:hover {
    background: var(--share-modal-button-background-hover);
  }

  @media (prefers-color-scheme: light) {
    .share-modal-backdrop {
      --share-modal-backdrop-background: #edf2f8;
      --share-modal-card-background: #fdfefe;
      --share-modal-card-background-top: #eef5fb;
      --share-modal-card-border: #c7d6e4;
      --share-modal-card-shadow: rgba(57, 73, 96, 0.18);
      --share-modal-panel-background: #f3f7fb;
      --share-modal-panel-border: #d7e1ec;
      --share-modal-text: #0e1726;
      --share-modal-muted-text: #5d6a7c;
      --share-modal-link-text: #2457b2;
      --share-modal-button-background: #f2f6fa;
      --share-modal-button-background-hover: #e6edf5;
      --share-modal-button-border: #c7d3df;
      --share-modal-eyebrow: #0c8d70;
      --share-modal-copy-success-text: #184c36;
      --share-modal-copy-success-border: #8bcfb1;
      --share-modal-copy-success-background: #d9f3e7;
      --share-modal-copy-ready-text: #6e4f10;
      --share-modal-copy-ready-border: #e0c16f;
      --share-modal-copy-ready-background: #f9ebb9;
      --share-modal-loading-background-start: #ffffff;
      --share-modal-loading-background-end: #edf2f7;
      --share-modal-loading-spinner-track: rgba(14, 23, 38, 0.12);
      --share-modal-loading-spinner-head: rgba(14, 23, 38, 0.78);
    }
  }

  @keyframes share-modal-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 640px) {
    .share-modal-backdrop {
      padding: 12px;
    }

    .share-modal-card {
      padding: 16px;
      border-radius: 20px;
    }

    .share-modal-header {
      flex-direction: column;
    }
  }
</style>
