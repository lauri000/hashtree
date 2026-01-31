<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteURL } from 'svelte/reactivity';
  import { isNHash, isNPath } from '@hashtree/core';
  import NostrLogin from './components/NostrLogin.svelte';
  import ConnectivityIndicator from './components/ConnectivityIndicator.svelte';
  import BandwidthIndicator from './components/BandwidthIndicator.svelte';
  import WalletLink from './components/WalletLink.svelte';
  import Toast from './components/Toast.svelte';
  import IrisRouter from './components/IrisRouter.svelte';
  import ShareModal, { open as openShareModal } from './components/Modals/ShareModal.svelte';
  import { currentPath, initRouter, navigate, refresh } from './lib/router.svelte';
  import { settingsStore } from './stores/settings';
  import { appsStore } from './stores/apps';
  import { fetchPWA } from './lib/pwaFetcher';
  import { savePWAToHashtree } from './lib/pwaSaver';

  let showConnectivity = $derived($settingsStore.pools.showConnectivity ?? true);
  let showBandwidth = $derived($settingsStore.pools.showBandwidth ?? false);

  // Navigation history for back/forward
  let historyStack = $state<string[]>([]);
  let historyIndex = $state(-1);
  let canGoBack = $derived(historyIndex > 0);
  let canGoForward = $derived(historyIndex < historyStack.length - 1);

  // Address bar
  let addressValue = $state('');
  let isAddressFocused = $state(false);
  let addressInputEl: HTMLInputElement | null = $state(null);

  // Bookmark state
  let isSaving = $state(false);
  let currentUrl = $derived.by(() => {
    const path = $currentPath;
    if (path.startsWith('/app/')) {
      try {
        return decodeURIComponent(path.slice(5));
      } catch {
        return null;
      }
    }
    if (path.startsWith('/nhash')) {
      return path;
    }
    return null;
  });
  let isBookmarked = $derived(currentUrl ? $appsStore.some(app => app.url === currentUrl) : false);
  let canBookmark = $derived(currentUrl !== null);

  function normalizeAppPath(path: string): string | null {
    if (!path.startsWith('/app/')) return null;
    try {
      const decoded = decodeURIComponent(path.slice(5));
      const url = new SvelteURL(decoded);
      if ((!url.hash || url.hash === '#') && url.pathname.endsWith('.html')) {
        url.hash = '#/';
      }
      return url.href;
    } catch {
      return null;
    }
  }

  function pathsMatch(a: string, b: string): boolean {
    if (a === b) return true;
    const normalizedA = normalizeAppPath(a);
    const normalizedB = normalizeAppPath(b);
    if (normalizedA && normalizedB) return normalizedA === normalizedB;
    return false;
  }

  function replaceHistoryEntry(stack: string[], index: number, path: string): string[] {
    const next = [...stack];
    next[index] = path;
    return next;
  }

  // Convert internal path to display value for address bar
  function pathToDisplayValue(path: string): string {
    if (path === '/') return '';
    if (path.startsWith('/app/')) {
      try {
        const url = decodeURIComponent(path.slice(5));
        return url.replace(/^https?:\/\//, '');
      } catch {
        return path;
      }
    }
    return path;
  }

  // Track path changes for history
  $effect(() => {
    const path = $currentPath;
    if (path) {
      if (historyStack.length === 0) {
        historyStack = [path];
        historyIndex = 0;
      } else if (!pathsMatch(historyStack[historyIndex], path)) {
        if (historyIndex > 0 && pathsMatch(historyStack[historyIndex - 1], path)) {
          const nextIndex = historyIndex - 1;
          historyIndex = nextIndex;
          historyStack = replaceHistoryEntry(historyStack, nextIndex, path);
        } else if (historyIndex + 1 < historyStack.length && pathsMatch(historyStack[historyIndex + 1], path)) {
          const nextIndex = historyIndex + 1;
          historyIndex = nextIndex;
          historyStack = replaceHistoryEntry(historyStack, nextIndex, path);
        } else {
          historyStack = [...historyStack.slice(0, historyIndex + 1), path];
          historyIndex = historyStack.length - 1;
        }
      }
    }
    if (!isAddressFocused) {
      addressValue = pathToDisplayValue(path);
    }
  });

  function goBack() {
    if (!canGoBack) return;
    historyIndex--;
    navigate(historyStack[historyIndex]);
  }

  function goForward() {
    if (!canGoForward) return;
    historyIndex++;
    navigate(historyStack[historyIndex]);
  }

  // Check if value starts with a hashtree identifier (nhash1, npath1, npub1)
  function isHashtreeIdentifier(value: string): boolean {
    const firstSegment = value.split('/')[0];
    return isNHash(firstSegment) || isNPath(firstSegment) || (firstSegment.startsWith('npub1') && firstSegment.length >= 63);
  }

  function extractHashRoute(value: string): string | null {
    if (value.startsWith('#/')) {
      return value.slice(1);
    }

    try {
      const url = new URL(value);
      if (url.hash && url.hash.startsWith('#/')) {
        return url.hash.slice(1);
      }
    } catch {
      // Not a URL
    }

    return null;
  }

  function extractHashtreePath(value: string): string | null {
    let trimmed = value.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('htree://')) {
      trimmed = trimmed.slice('htree://'.length);
    }

    // Avoid treating full URLs as internal routes.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return null;

    const normalized = trimmed.replace(/^\/+/, '');
    const prefixes = ['nhash1', 'npath1', 'npub1'];
    let start = -1;
    for (const prefix of prefixes) {
      const idx = normalized.lastIndexOf(prefix);
      if (idx > start) start = idx;
    }
    if (start === -1) return null;

    const candidate = normalized.slice(start);
    if (!isHashtreeIdentifier(candidate)) return null;
    return `/${candidate}`;
  }

  function handleAddressSubmit() {
    const value = addressValue.trim();
    if (!value) {
      navigate('/');
      addressInputEl?.blur();
      isAddressFocused = false;
      return;
    }

    const hashRoute = extractHashRoute(value);
    if (hashRoute) {
      navigate(hashRoute);
      addressInputEl?.blur();
      isAddressFocused = false;
      return;
    }

    const hashtreePath = extractHashtreePath(value);
    if (hashtreePath) {
      navigate(hashtreePath);
      addressInputEl?.blur();
      isAddressFocused = false;
      return;
    }

    if (value.startsWith('http://') || value.startsWith('https://')) {
      navigate(`/app/${encodeURIComponent(value)}`);
    } else if (value.startsWith('/')) {
      navigate(value);
    } else if (value.includes('.') && !value.includes(' ')) {
      navigate(`/app/${encodeURIComponent('https://' + value)}`);
    } else {
      navigate(`/${value}`);
    }
    addressInputEl?.blur();
    isAddressFocused = false;
  }

  function getShareableUrl(): string {
    const url = new SvelteURL(window.location.href);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = 'iris.to';
      url.port = '';
      url.protocol = 'https:';
    }
    return url.toString();
  }

  function handleShare() {
    openShareModal(getShareableUrl());
  }

  async function handleBookmark() {
    if (!currentUrl || isSaving) return;

    if (isBookmarked) {
      appsStore.remove(currentUrl);
      return;
    }

    if (currentUrl.startsWith('http')) {
      isSaving = true;
      try {
        const pwaInfo = await fetchPWA(currentUrl);
        const nhashUrl = await savePWAToHashtree(pwaInfo);
        const appName = pwaInfo.manifest?.name || pwaInfo.manifest?.short_name || new SvelteURL(currentUrl).hostname;

        appsStore.add({
          url: nhashUrl,
          name: appName,
          addedAt: Date.now(),
        });

        navigate(nhashUrl);
      } catch (error) {
        console.error('[Bookmark] Failed to save:', error);
        appsStore.add({
          url: currentUrl,
          name: new SvelteURL(currentUrl).hostname,
          addedAt: Date.now(),
        });
      } finally {
        isSaving = false;
      }
    } else {
      appsStore.add({
        url: currentUrl,
        name: 'Saved App',
        addedAt: Date.now(),
      });
    }
  }

  onMount(() => {
    initRouter();
  });
</script>

<div class="h-screen flex flex-col bg-surface-0 overscroll-none">
  <!-- Safari-style toolbar -->
  <div
    class="h-12 shrink-0 flex items-center gap-2 px-3 bg-surface-1 border-b border-surface-2"
    style="padding-left: 80px;"
  >
    <!-- Back/Forward/Home buttons -->
    <div class="flex items-center gap-1">
      <button
        class="btn-circle btn-ghost"
        onclick={goBack}
        disabled={!canGoBack}
        title="Back"
      >
        <span class="i-lucide-chevron-left text-lg"></span>
      </button>
      <button
        class="btn-circle btn-ghost"
        onclick={goForward}
        disabled={!canGoForward}
        title="Forward"
      >
        <span class="i-lucide-chevron-right text-lg"></span>
      </button>
      <button
        class="btn-circle btn-ghost"
        onclick={() => navigate('/')}
        disabled={$currentPath === '/'}
        title="Home"
      >
        <span class="i-lucide-home text-lg"></span>
      </button>
    </div>

    <!-- Address bar with bookmark star -->
    <div class="flex-1 flex justify-center">
      <div class="w-full max-w-lg flex items-center gap-2 px-3 py-1 rounded-full bg-surface-0 b-1 b-solid b-surface-3 transition-colors {isAddressFocused ? 'b-accent' : ''}">
        <!-- Bookmark/Star button -->
        <button
          class="shrink-0 text-text-3 hover:text-text-1 disabled:opacity-30"
          onclick={handleBookmark}
          disabled={!canBookmark || isSaving}
          title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
        >
          {#if isSaving}
            <span class="i-lucide-loader-2 animate-spin"></span>
          {:else if isBookmarked}
            <span class="i-lucide-star text-yellow-500 fill-yellow-500"></span>
          {:else}
            <span class="i-lucide-star"></span>
          {/if}
        </button>
        <span class="i-lucide-search text-sm text-muted shrink-0"></span>
        <input
          type="text"
          bind:this={addressInputEl}
          bind:value={addressValue}
          onfocus={() => isAddressFocused = true}
          onblur={() => isAddressFocused = false}
          onkeydown={(e) => e.key === 'Enter' && handleAddressSubmit()}
          onpaste={(e) => {
            const text = e.clipboardData?.getData('text');
            if (text) {
              e.preventDefault();
              addressValue = text;
            }
          }}
          placeholder="Search or enter address"
          class="bg-transparent border-none outline-none text-sm text-text-1 placeholder:text-muted flex-1 text-center"
        />
        {#if currentUrl}
          <button
            class="shrink-0 text-text-3 hover:text-text-1"
            onclick={refresh}
            title="Refresh"
          >
            <span class="i-lucide-refresh-cw text-sm"></span>
          </button>
        {/if}
      </div>
    </div>

    <!-- Right side: share, connectivity, wallet, avatar -->
    <div class="flex items-center gap-2">
      <button
        class="btn-circle btn-ghost"
        onclick={handleShare}
        title="Share"
      >
        <span class="i-lucide-share text-lg"></span>
      </button>
      {#if showBandwidth}
        <BandwidthIndicator />
      {/if}
      {#if showConnectivity}
        <ConnectivityIndicator />
      {/if}
      <WalletLink />
      <NostrLogin />
    </div>
  </div>

  <!-- Content area -->
  <main class="flex-1 flex flex-col overflow-auto">
    <IrisRouter />
  </main>
</div>

<Toast />
<ShareModal />
