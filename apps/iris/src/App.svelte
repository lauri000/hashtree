<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    createNip07Webview,
    createHtreeWebview,
    closeWebview,
    navigateWebview,
    webviewHistory,
    reloadWebview,
    setWebviewBounds,
    onChildWebviewLocation,
    recordHistoryVisit,
    searchHistory,
    getRecentHistory,
    deleteHistoryEntry,
    type WebviewLocationEvent,
    type HistoryEntry,
  } from './lib/tauri';
  import { appsStore } from './stores/apps';
  import AppLauncher from './components/AppLauncher.svelte';
  import Settings from './components/Settings.svelte';

  type View = 'launcher' | 'settings' | 'webview';

  const CHILD_LABEL = 'content';
  const TOOLBAR_HEIGHT = 48;

  let addressValue = $state('');
  let currentUrl = $state('');              // full URL for editing
  let isAddressFocused = $state(false);
  let addressInputEl: HTMLInputElement | null = $state(null);
  let currentView: View = $state('launcher');

  // Autocomplete dropdown
  let showDropdown = $state(false);
  let dropdownItems: HistoryEntry[] = $state([]);
  let selectedIndex = $state(-1);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  let boundsRaf: number | null = null;
  let dropdownEl: HTMLDivElement | null = $state(null);

  // Shell-level navigation history
  let historyStack: string[] = $state([]);  // URLs visited
  let historyIndex = $state(-1);            // -1 = launcher

  // Intra-webview navigation tracking
  let webviewNavDepth = $state(0);          // user navigations within current webview
  let webviewFwdAvail = $state(0);          // forward steps available within webview
  let ignoreLocationEvents = 0;             // skip location events we caused

  let canGoBack = $derived(
    (currentView === 'webview' && webviewNavDepth > 0) ||
    historyIndex >= 0 ||
    currentView !== 'launcher'
  );
  let canGoForward = $derived(
    (currentView === 'webview' && webviewFwdAvail > 0) ||
    historyIndex < historyStack.length - 1
  );

  // Track child webview existence at module level to survive HMR
  const g = globalThis as typeof globalThis & { __irisChildReady?: boolean };

  function urlToDisplay(url: string): string {
    try {
      return url.replace(/^(https?|htree):\/\//, '').replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  function displayToUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    if (trimmed.startsWith('htree://')) return trimmed;
    if (trimmed.startsWith('nhash1') || trimmed.startsWith('npub1')) return `htree://${trimmed}`;
    if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`;
    return `https://${trimmed}`;
  }

  function handleLocationChange(event: WebviewLocationEvent) {
    if (event.label !== CHILD_LABEL) return;
    currentUrl = event.url;
    if (!isAddressFocused) {
      addressValue = urlToDisplay(event.url);
    }
    if (ignoreLocationEvents > 0) {
      ignoreLocationEvents--;
      return;
    }
    if (isRecordableUrl(event.url)) {
      recordHistoryVisit(buildHistoryEntry(event.url))
        .catch((e) => console.warn('[Iris] record history failed:', e));
    }
    // User navigated within webview (clicked a link, etc.)
    if (currentView === 'webview') {
      webviewNavDepth++;
      webviewFwdAvail = 0;
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

  function isRecordableUrl(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('htree://');
  }

  function buildHistoryEntry(url: string) {
    const htree = parseHtreeUrl(url);
    return {
      path: url,
      label: htree?.treename || urlToDisplay(url),
      entry_type: htree ? 'tree' : 'web',
      npub: htree?.npub ?? null,
      tree_name: htree?.treename ?? null,
    };
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

  /** Open a URL in the child webview, pushing to history. */
  async function navigate(url: string, pushHistory = true) {
    // Destroy existing child webview when switching origins or entering webview
    if (g.__irisChildReady) {
      const htree = parseHtreeUrl(url);
      if (htree || currentView !== 'webview') {
        await destroyChildWebview();
      }
    }

    ignoreLocationEvents++;
    webviewNavDepth = 0;
    webviewFwdAvail = 0;

    currentView = 'webview';
    currentUrl = url;
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

    if (pushHistory) {
      // Truncate any forward history, then push
      historyStack = [...historyStack.slice(0, historyIndex + 1), url];
      historyIndex = historyStack.length - 1;

      // Record visit for autocomplete
      const entry = buildHistoryEntry(url);
      recordHistoryVisit(entry)
        .catch((e) => console.warn('[Iris] record history failed:', e));
    }

    if (!isAddressFocused) {
      addressValue = urlToDisplay(url);
    }
  }

  async function goHome() {
    await destroyChildWebview();
    currentView = 'launcher';
    currentUrl = '';
    addressValue = '';
    webviewNavDepth = 0;
    webviewFwdAvail = 0;
  }

  function goSettings() {
    destroyChildWebview();
    currentView = 'settings';
    currentUrl = '';
    addressValue = '';
    webviewNavDepth = 0;
    webviewFwdAvail = 0;
  }

  let isFavorited = $derived(currentUrl ? $appsStore.some(a => a.url === currentUrl) : false);

  function toggleFavorite() {
    if (!currentUrl) return;
    if (isFavorited) {
      appsStore.remove(currentUrl);
    } else {
      const hostname = (() => { try { return new URL(currentUrl).hostname; } catch { return currentUrl; } })();
      appsStore.add({ url: currentUrl, name: hostname, addedAt: Date.now() });
    }
  }

  async function refresh() {
    if (currentView === 'webview' && g.__irisChildReady) {
      await reloadWebview(CHILD_LABEL);
    }
  }

  async function fetchDropdownItems(query: string) {
    try {
      if (!query.trim()) {
        const recent = await getRecentHistory(8);
        dropdownItems = recent;
      } else {
        const results = await searchHistory(query, 8);
        dropdownItems = results.map(r => r.entry);
      }
    } catch (e) {
      console.error('[Iris] history fetch failed:', e);
      dropdownItems = [];
    }
    selectedIndex = -1;
    scheduleWebviewBoundsUpdate();
  }

  function debouncedSearch(query: string) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fetchDropdownItems(query), 150);
  }

  function closeDropdown() {
    showDropdown = false;
    dropdownItems = [];
    selectedIndex = -1;
    if (debounceTimer) clearTimeout(debounceTimer);
    scheduleWebviewBoundsUpdate();
  }

  function handleDropdownSelect(entry: HistoryEntry) {
    closeDropdown();
    isAddressFocused = false;
    addressValue = urlToDisplay(entry.path);
    currentUrl = entry.path;
    navigate(entry.path);
    addressInputEl?.blur();
  }

  async function handleDeleteHistoryItem(event: MouseEvent, path: string) {
    event.stopPropagation();
    await deleteHistoryEntry(path);
    dropdownItems = dropdownItems.filter(item => item.path !== path);
  }

  function handleAddressFocus() {
    // Cancel any pending blur-close so it doesn't kill the new dropdown
    if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
    isAddressFocused = true;
    if (currentUrl) {
      addressValue = currentUrl;
    }
    showDropdown = true;
    fetchDropdownItems(addressValue);
    scheduleWebviewBoundsUpdate();
    // Select all text for easy replacement
    requestAnimationFrame(() => addressInputEl?.select());
  }

  function handleAddressBlur() {
    isAddressFocused = false;
    if (currentUrl) {
      addressValue = urlToDisplay(currentUrl);
    }
    // Delay to allow mousedown on dropdown items to fire first
    blurTimer = setTimeout(() => { blurTimer = null; closeDropdown(); }, 150);
  }

  function scheduleWebviewBoundsUpdate() {
    if (boundsRaf !== null) cancelAnimationFrame(boundsRaf);
    boundsRaf = requestAnimationFrame(async () => {
      boundsRaf = null;
      if (currentView !== 'webview' || !g.__irisChildReady) return;
      const extra = showDropdown ? (dropdownEl?.getBoundingClientRect().height ?? 0) : 0;
      const top = TOOLBAR_HEIGHT + extra;
      const height = Math.max(0, window.innerHeight - top);
      try {
        await setWebviewBounds(CHILD_LABEL, 0, top, window.innerWidth, height);
      } catch {
        // If the webview is gone or not ready, ignore.
      }
    });
  }

  function handleGlobalKeyDown(event: KeyboardEvent) {
    if ((event.key !== 'Escape' && event.key !== 'Esc') || !showDropdown) return;
    isAddressFocused = false;
    closeDropdown();
    addressInputEl?.blur();
  }

  async function goBack() {
    if (currentView === 'webview' && webviewNavDepth > 0) {
      // Navigate back within the webview
      ignoreLocationEvents++;
      await webviewHistory(CHILD_LABEL, 'back');
      webviewNavDepth--;
      webviewFwdAvail++;
    } else if (historyIndex > 0) {
      historyIndex--;
      await navigate(historyStack[historyIndex], false);
    } else {
      // At first page or no history — go to launcher
      historyIndex = -1;
      goHome();
    }
  }

  async function goForward() {
    if (currentView === 'webview' && webviewFwdAvail > 0) {
      // Navigate forward within the webview
      ignoreLocationEvents++;
      await webviewHistory(CHILD_LABEL, 'forward');
      webviewNavDepth++;
      webviewFwdAvail--;
    } else if (historyIndex < historyStack.length - 1) {
      historyIndex++;
      await navigate(historyStack[historyIndex], false);
    }
  }

  function handleAddressSubmit() {
    if (showDropdown && selectedIndex >= 0 && selectedIndex < dropdownItems.length) {
      handleDropdownSelect(dropdownItems[selectedIndex]);
      return;
    }
    closeDropdown();
    const url = displayToUrl(addressValue);
    isAddressFocused = false;
    if (url) {
      currentUrl = url;
      addressValue = urlToDisplay(url);
      navigate(url);
    }
    addressInputEl?.blur();
  }

  onMount(async () => {
    const unlisten = await onChildWebviewLocation(handleLocationChange);
    window.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('resize', scheduleWebviewBoundsUpdate);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
      window.removeEventListener('resize', scheduleWebviewBoundsUpdate);
      unlisten();
    };
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
      <button class="btn-circle btn-ghost" class:opacity-40={!canGoBack} onclick={goBack} disabled={!canGoBack} title="Back">
        <span class="i-lucide-chevron-left text-lg"></span>
      </button>
      <button class="btn-circle btn-ghost" class:opacity-40={!canGoForward} onclick={goForward} disabled={!canGoForward} title="Forward">
        <span class="i-lucide-chevron-right text-lg"></span>
      </button>
      <button class="btn-circle btn-ghost" onclick={goHome} title="Home">
        <span class="i-lucide-home text-lg"></span>
      </button>
    </div>

    <div data-tauri-drag-region class="flex-1 flex justify-center relative">
      <div class="w-full max-w-lg flex items-center gap-2 px-3 py-1 rounded-full bg-surface-0 b-1 b-solid b-surface-3 transition-colors {isAddressFocused ? 'b-accent' : ''}">
        {#if currentUrl}
          <button
            class="shrink-0 text-text-3 hover:text-text-1"
            onclick={refresh}
            title="Refresh"
          >
            <span class="i-lucide-refresh-cw text-sm"></span>
          </button>
        {/if}
        <span data-tauri-drag-region class="i-lucide-search text-sm text-muted shrink-0"></span>
        <input
          type="text"
          bind:this={addressInputEl}
          bind:value={addressValue}
          onfocus={handleAddressFocus}
          onblur={handleAddressBlur}
          oninput={() => {
            if (!isAddressFocused) return;
            showDropdown = true;
            debouncedSearch(addressValue);
          }}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              handleAddressSubmit();
            } else if (e.key === 'Escape' || e.key === 'Esc') {
              isAddressFocused = false;
              closeDropdown();
              addressInputEl?.blur();
            } else if (e.key === 'ArrowDown' && showDropdown && dropdownItems.length > 0) {
              e.preventDefault();
              selectedIndex = selectedIndex < 0 ? 0 : (selectedIndex + 1) % dropdownItems.length;
            } else if (e.key === 'ArrowUp' && showDropdown && dropdownItems.length > 0) {
              e.preventDefault();
              selectedIndex = selectedIndex <= 0 ? dropdownItems.length - 1 : selectedIndex - 1;
            }
          }}
          placeholder="Search or enter address"
          class="bg-transparent border-none outline-none text-sm text-text-1 placeholder:text-muted flex-1 text-center"
        />
        <button
          class="shrink-0 text-text-3 hover:text-text-1 disabled:opacity-30"
          onclick={toggleFavorite}
          disabled={!currentUrl}
          title={isFavorited ? 'Unfavourite' : 'Favourite'}
        >
          {#if isFavorited}
            <span class="i-lucide-star text-yellow-500 fill-yellow-500"></span>
          {:else}
            <span class="i-lucide-star"></span>
          {/if}
        </button>
      </div>

      {#if showDropdown && dropdownItems.length > 0}
        <div bind:this={dropdownEl} class="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-full max-w-lg bg-surface-1 b-1 b-solid b-surface-3 rounded-lg overflow-hidden z-50 max-h-80 overflow-y-auto" role="listbox">
          {#each dropdownItems as item, i}
            <div
              class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2 transition-colors cursor-pointer {i === selectedIndex ? 'bg-surface-2' : ''}"
              onmousedown={() => handleDropdownSelect(item)}
              role="option"
              aria-selected={i === selectedIndex}
              tabindex="-1"
            >
              <span class="i-lucide-clock text-sm text-text-3 shrink-0"></span>
              <div class="flex-1 min-w-0">
                <div class="text-sm text-text-1 truncate">{item.label}</div>
                <div class="text-xs text-text-3 truncate">{urlToDisplay(item.path)}</div>
              </div>
              <button
                class="shrink-0 text-text-3 hover:text-danger p-1"
                onmousedown={(e) => handleDeleteHistoryItem(e, item.path)}
                title="Delete"
              >
                <span class="i-lucide-x text-sm"></span>
              </button>
            </div>
          {/each}
        </div>
      {/if}
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
