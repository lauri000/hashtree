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
        <div>
          <p class="share-modal-eyebrow">Share</p>
          <h2 class="share-modal-title">Open this site elsewhere</h2>
        </div>
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
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(2, 4, 8, 0.72);
    backdrop-filter: blur(14px);
  }

  .share-modal-card {
    margin: 0;
    width: min(420px, calc(100vw - 24px));
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 18px;
    border-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background:
      radial-gradient(circle at top, rgba(141, 225, 192, 0.12), transparent 55%),
      rgba(6, 9, 17, 0.96);
    box-shadow: 0 28px 80px rgba(0, 0, 0, 0.42);
  }

  .share-modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .share-modal-eyebrow {
    margin: 0 0 6px;
    font-size: 0.72rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #8de1c0;
  }

  .share-modal-title {
    margin: 0;
    font-size: 1.08rem;
    line-height: 1.2;
  }

  .share-modal-close,
  .share-modal-copy-button,
  .share-modal-native-button {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.05);
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
    background: linear-gradient(180deg, #f5f5f5 0%, #e6e6e6 100%);
  }

  .share-modal-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(5, 5, 7, 0.12);
    border-top-color: rgba(5, 5, 7, 0.8);
    border-radius: 999px;
    animation: share-modal-spin 720ms linear infinite;
  }

  .share-modal-url-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .share-modal-url-label {
    margin: 0;
    font-size: 0.76rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(243, 243, 244, 0.58);
  }

  .share-modal-url-text {
    font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
    font-size: 0.82rem;
    line-height: 1.5;
    color: rgba(168, 209, 255, 0.96);
    word-break: break-all;
  }

  .share-modal-copy-button,
  .share-modal-native-button {
    width: 100%;
    padding: 11px 14px;
  }

  .share-modal-copy-button[data-state="copied"] {
    color: #b9f5df;
    border-color: rgba(110, 231, 183, 0.24);
    background: rgba(110, 231, 183, 0.12);
  }

  .share-modal-copy-button[data-state="ready"] {
    color: #ffe6a3;
    border-color: rgba(251, 191, 36, 0.24);
    background: rgba(251, 191, 36, 0.12);
  }

  .share-modal-close:hover,
  .share-modal-copy-button:hover,
  .share-modal-native-button:hover {
    background: rgba(255, 255, 255, 0.09);
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
