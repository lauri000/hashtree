<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    createNip07Webview,
    createHtreeWebview,
    closeWebview,
    navigateWebview,
    webviewHistory,
    onChildWebviewLocation,
    type WebviewLocationEvent,
  } from './lib/tauri';
  import AppLauncher from './components/AppLauncher.svelte';
  import Settings from './components/Settings.svelte';

  type View = 'launcher' | 'settings' | 'webview';

  const CHILD_LABEL = 'content';
  const TOOLBAR_HEIGHT = 48;

  let addressValue = $state('');
  let isAddressFocused = $state(false);
  let addressInputEl: HTMLInputElement | null = $state(null);
  let currentView: View = $state('launcher');

  // Track child webview existence at module level to survive HMR
  const g = globalThis as typeof globalThis & { __irisChildReady?: boolean };

  function urlToDisplay(url: string): string {
    try {
      return url.replace(/^https?:\/\//, '');
    } catch {
      return url;
    }
  }

  function displayToUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    if (trimmed.startsWith('htree://')) return trimmed;
    if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`;
    return `https://${trimmed}`;
  }

  function handleLocationChange(event: WebviewLocationEvent) {
    if (event.label !== CHILD_LABEL) return;
    if (!isAddressFocused) {
      addressValue = urlToDisplay(event.url);
    }
  }

  /** Parse htree://npub/treename/path or htree://nhash/path */
  function parseHtreeUrl(url: string): { nhash?: string; npub?: string; treename?: string; path: string } | null {
    if (!url.startsWith('htree://')) return null;
    const rest = url.slice('htree://'.length);
    const parts = rest.split('/');
    const host = parts[0];
    if (host.startsWith('npub1')) {
      const treename = parts[1] || '';
      const path = '/' + parts.slice(2).join('/');
      return { npub: host, treename, path };
    } else if (host.startsWith('nhash1')) {
      const path = '/' + parts.slice(1).join('/');
      return { nhash: host, path };
    }
    return null;
  }

  async function destroyChildWebview() {
    // Always try to close, regardless of tracked state
    try {
      await closeWebview(CHILD_LABEL);
    } catch {
      // Webview might not exist, that's fine
    }
    g.__irisChildReady = false;
  }

  async function navigate(url: string) {
    // If there's an existing child webview, close it first when switching views
    if (g.__irisChildReady) {
      // For htree:// URLs we must recreate (different init scripts per origin)
      // For http(s) URLs, reuse existing webview if possible
      const htree = parseHtreeUrl(url);
      if (htree || currentView !== 'webview') {
        await destroyChildWebview();
      }
    }

    currentView = 'webview';
    await tick();

    const x = 0;
    const y = TOOLBAR_HEIGHT;
    const width = window.innerWidth;
    const height = window.innerHeight - TOOLBAR_HEIGHT;

    if (!g.__irisChildReady) {
      const htree = parseHtreeUrl(url);
      try {
        if (htree) {
          await createHtreeWebview(CHILD_LABEL, htree, x, y, width, height);
        } else {
          await createNip07Webview(CHILD_LABEL, url, x, y, width, height);
        }
        g.__irisChildReady = true;
      } catch (e) {
        console.warn('[Iris] create webview failed, trying navigate:', e);
        try {
          await navigateWebview(CHILD_LABEL, url);
          g.__irisChildReady = true;
        } catch (e2) {
          console.error('[Iris] navigate also failed:', e2);
        }
      }
    } else {
      await navigateWebview(CHILD_LABEL, url);
    }
    if (!isAddressFocused) {
      addressValue = urlToDisplay(url);
    }
  }

  async function goHome() {
    await destroyChildWebview();
    currentView = 'launcher';
    addressValue = '';
  }

  function goSettings() {
    destroyChildWebview();
    currentView = 'settings';
    addressValue = '';
  }

  async function goBack() {
    if (currentView === 'settings') {
      goHome();
      return;
    }
    try {
      await webviewHistory(CHILD_LABEL, 'back');
    } catch {
      // No webview or no history
    }
  }

  async function goForward() {
    try {
      await webviewHistory(CHILD_LABEL, 'forward');
    } catch {
      // No webview
    }
  }

  function handleAddressSubmit() {
    const url = displayToUrl(addressValue);
    if (url) {
      navigate(url);
    }
    addressInputEl?.blur();
    isAddressFocused = false;
  }

  onMount(async () => {
    const unlisten = await onChildWebviewLocation(handleLocationChange);
    return unlisten;
  });
</script>

<div class="h-screen flex flex-col bg-surface-0 overscroll-none">
  <!-- Toolbar - data-tauri-drag-region on every non-interactive element -->
  <div
    data-tauri-drag-region
    class="h-12 shrink-0 flex items-center gap-2 px-3 bg-surface-1 border-b border-surface-2"
    style="padding-left: 88px;"
  >
    <div data-tauri-drag-region class="flex items-center gap-1">
      <button class="btn-circle btn-ghost" onclick={goBack} title="Back">
        <span class="i-lucide-chevron-left text-lg"></span>
      </button>
      <button class="btn-circle btn-ghost" onclick={goForward} title="Forward">
        <span class="i-lucide-chevron-right text-lg"></span>
      </button>
      <button class="btn-circle btn-ghost" onclick={goHome} title="Home">
        <span class="i-lucide-home text-lg"></span>
      </button>
    </div>

    <div data-tauri-drag-region class="flex-1 flex justify-center">
      <div class="w-full max-w-lg flex items-center gap-2 px-3 py-1 rounded-full bg-surface-0 b-1 b-solid b-surface-3 transition-colors {isAddressFocused ? 'b-accent' : ''}">
        <span data-tauri-drag-region class="i-lucide-search text-sm text-muted shrink-0"></span>
        <input
          type="text"
          bind:this={addressInputEl}
          bind:value={addressValue}
          onfocus={() => isAddressFocused = true}
          onblur={() => isAddressFocused = false}
          onkeydown={(e) => e.key === 'Enter' && handleAddressSubmit()}
          placeholder="Search or enter address"
          class="bg-transparent border-none outline-none text-sm text-text-1 placeholder:text-muted flex-1 text-center"
        />
      </div>
    </div>

    <button
      class="btn-circle btn-ghost"
      onclick={goSettings}
      title="Settings"
    >
      <span class="i-lucide-settings text-lg"></span>
    </button>
  </div>

  <!-- Content area -->
  <main class="flex-1 flex flex-col">
    {#if currentView === 'launcher'}
      <AppLauncher onnavigate={navigate} />
    {:else if currentView === 'settings'}
      <Settings />
    {/if}
    <!-- When currentView === 'webview', child webview overlays this area -->
  </main>
</div>
