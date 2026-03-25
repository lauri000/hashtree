<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    automationUpdateState,
    automationShutdown,
    clearTreeRootCache,
    createNip07Webview,
    createHtreeWebview,
    deepLinkFrontendReady,
    closeWebview,
    navigateWebview,
    onAutomationCommand,
    webviewHistory,
    reloadWebview,
    setWebviewBounds,
    onChildWebviewDiagnostic,
    onChildWebviewLocation,
    onChildWebviewPageLoad,
    recordHistoryVisit,
    searchHistory,
    getRecentHistory,
    deleteHistoryEntry,
    type AutomationCommandEvent,
    type WebviewDiagnosticEvent,
    type WebviewLocationEvent,
    type WebviewPageLoadEvent,
    type HistoryEntry,
  } from './lib/tauri';
  import { isBuiltInIrisApp } from './lib/apps';
  import { appsStore } from './stores/apps';
  import AppLauncher from './components/AppLauncher.svelte';
  import Settings from './components/Settings.svelte';

  type View = 'launcher' | 'settings' | 'webview';
  type NavigateOptions = {
    pushHistory?: boolean;
    preferPlainLoopbackHost?: boolean;
  };

  const CHILD_LABEL = 'content';
  const TOOLBAR_BASE_HEIGHT = 48;
  const COMPACT_TOOLBAR_BREAKPOINT = 720;
  const DESKTOP_TRAFFIC_LIGHTS_PADDING = 88;
  const MOBILE_CHILD_WEBVIEWS_UNSUPPORTED = 'Mobile child webviews are not supported yet';
  const BLANK_SUGGESTED_TREE_RECOVERY_DELAY_MS = 1500;
  const HTREE_LOAD_STALL_RECOVERY_DELAY_MS = 3000;
  const MACOS_FUNCTION_KEY_GLYPHS = /[\uF700-\uF8FF]/g;
  const MACOS_FUNCTION_KEY_GLYPHS_SINGLE = /[\uF700-\uF8FF]/;
  const LEGACY_MACOS_ARROW_KEY_CODES = new Set([63232, 63233, 63234, 63235]);
  const RECOVERABLE_TREE_BODY_TEXTS = new Set(['Not found', 'Resolution timeout']);
  const PRIVATE_USE_ARROW_KEYS = {
    '\uF700': 'ArrowUp',
    '\uF701': 'ArrowDown',
    '\uF702': 'ArrowLeft',
    '\uF703': 'ArrowRight',
  } as const;
  const g = globalThis as typeof globalThis & { __irisChildReady?: boolean };

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
  let blankSuggestedTreeRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let childLoadStallRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let boundsRaf: number | null = null;
  let automationSyncRaf: number | null = null;
  let dropdownEl: HTMLDivElement | null = $state(null);
  let safeAreaTopInsetEl: HTMLDivElement | null = $state(null);
  let toolbarHeight = $state(TOOLBAR_BASE_HEIGHT);
  let isCompactToolbar = $state(
    typeof window !== 'undefined' && window.innerWidth < COMPACT_TOOLBAR_BREAKPOINT
  );
  let showMobileMenu = $state(false);
  let mobileMenuEl: HTMLDivElement | null = $state(null);

  // Shell-level navigation history
  let historyStack: string[] = $state([]);  // URLs visited
  let historyIndex = $state(-1);            // -1 = launcher

  // Intra-webview navigation tracking
  let webviewNavDepth = $state(0);          // user navigations within current webview
  let webviewFwdAvail = $state(0);          // forward steps available within webview
  let ignoreLocationEvents = 0;             // skip location events we caused
  const treeRootRecoveryAttempts = new Map<string, number>();
  let childPageLoadState = $state('idle');
  let childPageLoadUrl = $state('');
  let childDocumentTitle = $state('');
  let childBodyText = $state('');
  let childMediaSummary = $state('');
  let childLastError = $state('');
  let childWebviewReady = $state(!!g.__irisChildReady);
  let childUsesPlainLoopbackTransport = $state(false);
  const plainLoopbackFallbackScopes = new Set<string>();

  let canGoBack = $derived(
    (currentView === 'webview' && webviewNavDepth > 0) ||
    historyIndex >= 0 ||
    currentView !== 'launcher'
  );
  let canGoForward = $derived(
    (currentView === 'webview' && webviewFwdAvail > 0) ||
    historyIndex < historyStack.length - 1
  );
  let isChildLoading = $derived(
    currentView === 'webview' &&
    !!currentUrl &&
    childPageLoadState !== 'finished' &&
    !childLastError
  );

  function urlToDisplay(url: string): string {
    try {
      return url.replace(/^(https?|htree):\/\//, '').replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  function browserIsolationScope(url: string): string {
    const htree = parseHtreeUrl(url);
    if (htree?.nhash) {
      return `htree://${htree.nhash}`;
    }
    if (htree?.treename) {
      return `htree://${htree.host}/${encodeURIComponent(htree.treename)}/`;
    }

    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  function shouldRecreateBrowserForUrl(nextUrl: string, previousUrl: string): boolean {
    if (!previousUrl) return true;
    return browserIsolationScope(nextUrl) !== browserIsolationScope(previousUrl);
  }

  function displayToUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    if (trimmed.startsWith('htree://')) return trimmed;
    if (trimmed === 'self' || trimmed.startsWith('self/')) return `htree://${trimmed}`;
    if (trimmed.startsWith('nhash1') || trimmed.startsWith('npub1')) return `htree://${trimmed}`;
    if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`;
    return `https://${trimmed}`;
  }

  function sanitizeAddressText(value: string): string {
    return value.replace(MACOS_FUNCTION_KEY_GLYPHS, '');
  }

  function normalizedAddressKey(event: KeyboardEvent): string {
    const privateUseKey = PRIVATE_USE_ARROW_KEYS[event.key as keyof typeof PRIVATE_USE_ARROW_KEYS];
    if (privateUseKey) return privateUseKey;
    switch (event.keyCode || event.which) {
      case 37: return 'ArrowLeft';
      case 38: return 'ArrowUp';
      case 39: return 'ArrowRight';
      case 40: return 'ArrowDown';
      case 63232: return 'ArrowUp';
      case 63233: return 'ArrowDown';
      case 63234: return 'ArrowLeft';
      case 63235: return 'ArrowRight';
      default: return event.key;
    }
  }

  function isLegacyMacosArrowKeyCode(event: KeyboardEvent): boolean {
    return LEGACY_MACOS_ARROW_KEY_CODES.has(event.keyCode || event.which);
  }

  function isMacosFunctionArrowEvent(event: KeyboardEvent): boolean {
    return MACOS_FUNCTION_KEY_GLYPHS_SINGLE.test(event.key) || isLegacyMacosArrowKeyCode(event);
  }

  function moveAddressCaret(direction: -1 | 1) {
    const input = addressInputEl;
    if (!input) return;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const hasSelection = start !== end;
    const boundary = direction < 0 ? Math.min(start, end) : Math.max(start, end);
    const next = hasSelection
      ? boundary
      : Math.max(0, Math.min(input.value.length, boundary + direction));
    input.setSelectionRange(next, next);
  }

  function sanitizeAddressFieldValue() {
    const input = addressInputEl;
    const rawValue = input?.value ?? addressValue;
    const sanitizedValue = sanitizeAddressText(rawValue);

    if (rawValue === sanitizedValue) {
      if (addressValue !== rawValue) {
        addressValue = rawValue;
      }
      return sanitizedValue;
    }

    const selectionStart = input?.selectionStart ?? rawValue.length;
    const selectionEnd = input?.selectionEnd ?? rawValue.length;
    const removedBeforeStart = (rawValue.slice(0, selectionStart).match(MACOS_FUNCTION_KEY_GLYPHS) ?? []).length;
    const removedBeforeEnd = (rawValue.slice(0, selectionEnd).match(MACOS_FUNCTION_KEY_GLYPHS) ?? []).length;

    addressValue = sanitizedValue;

    requestAnimationFrame(() => {
      if (!addressInputEl) return;
      const nextStart = Math.max(0, selectionStart - removedBeforeStart);
      const nextEnd = Math.max(0, selectionEnd - removedBeforeEnd);
      addressInputEl.setSelectionRange(nextStart, nextEnd);
    });

    return sanitizedValue;
  }

  function setChildWebviewReady(ready: boolean) {
    g.__irisChildReady = ready;
    childWebviewReady = ready;
  }

  function formatWebviewError(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message) {
        return message;
      }
    }
    return 'Failed to open page.';
  }

  function isUnsupportedChildWebviewError(message: string): boolean {
    return message.includes(MOBILE_CHILD_WEBVIEWS_UNSUPPORTED);
  }

  function shouldRetryNavigateAfterCreateFailure(message: string): boolean {
    return !isUnsupportedChildWebviewError(message) && !message.includes('missing required key origin');
  }

  function setChildWebviewError(error: unknown) {
    childLastError = formatWebviewError(error);
    childPageLoadState = 'failed';
    setChildWebviewReady(false);
    scheduleAutomationStateSync();
  }

  function webviewErrorHeadline(error: string): string {
    return isUnsupportedChildWebviewError(error)
      ? 'Embedded browsing is not available on this device yet'
      : 'Could not open this page';
  }

  function webviewErrorDetail(error: string): string {
    return isUnsupportedChildWebviewError(error)
      ? 'Iris uses child webviews for in-app pages, and the current mobile runtime does not provide them yet.'
      : error;
  }

  function isFatalChildDiagnosticError(error: string, source?: string | null): boolean {
    const trimmed = error.trim();
    if (!trimmed) return false;

    const lower = trimmed.toLowerCase();
    if (
      lower.includes('notification.is_permission_granted not allowed') ||
      lower.includes("can't find variable: rtcpeerconnection") ||
      trimmed.includes('console:warn') ||
      trimmed.includes('worker:init:') ||
      trimmed.includes('worker:ready') ||
      trimmed.includes('media:setup:') ||
      trimmed.includes('prefix:')
    ) {
      return false;
    }

    if (source === 'resource-error') {
      return lower.startsWith('script failed to load') || lower.startsWith('link failed to load');
    }

    return trimmed.includes('console:error') ||
      trimmed.includes('window:error') ||
      trimmed.includes('window:unhandledrejection') ||
      lower.includes('failed to load') ||
      lower.includes('invalid session token') ||
      lower.includes('protocol bridge request failed') ||
      lower.includes('could not open');
  }

  function syncToolbarMode() {
    const nextIsCompactToolbar = window.innerWidth < COMPACT_TOOLBAR_BREAKPOINT;
    if (isCompactToolbar === nextIsCompactToolbar) return;
    isCompactToolbar = nextIsCompactToolbar;
    showMobileMenu = false;
  }

  function handleAddressBeforeInput(event: InputEvent) {
    if (!event.data) return;
    if (!MACOS_FUNCTION_KEY_GLYPHS_SINGLE.test(event.data)) return;
    event.preventDefault();
  }

  function handleAddressKeyPress(event: KeyboardEvent) {
    if (!isMacosFunctionArrowEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function handleAddressInput() {
    const sanitizedValue = sanitizeAddressFieldValue();
    if (!isAddressFocused) isAddressFocused = true;
    showDropdown = true;
    debouncedSearch(sanitizedValue);
  }

  function handleAddressKeyDown(event: KeyboardEvent) {
    const key = normalizedAddressKey(event);
    const isMacosFunctionArrow = isMacosFunctionArrowEvent(event);

    if (key === 'Enter') {
      handleAddressSubmit();
      return;
    }

    if (key === 'Escape' || key === 'Esc') {
      event.preventDefault();
      event.stopPropagation();
      dismissDropdown();
      return;
    }

    if (key === 'ArrowDown' && showDropdown && dropdownItems.length > 0) {
      event.preventDefault();
      selectedIndex = selectedIndex < 0 ? 0 : (selectedIndex + 1) % dropdownItems.length;
      return;
    }

    if (key === 'ArrowUp' && showDropdown && dropdownItems.length > 0) {
      event.preventDefault();
      selectedIndex = selectedIndex <= 0 ? dropdownItems.length - 1 : selectedIndex - 1;
      return;
    }

    if (!isMacosFunctionArrow) return;

    if (key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      moveAddressCaret(-1);
      return;
    }

    if (key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      moveAddressCaret(1);
      return;
    }

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handleLocationChange(event: WebviewLocationEvent) {
    if (event.label !== CHILD_LABEL) return;
    const previousUrl = currentUrl;
    currentUrl = event.url;
    if (!isAddressFocused) {
      addressValue = urlToDisplay(event.url);
    }
    if (ignoreLocationEvents > 0) {
      ignoreLocationEvents--;
      return;
    }
    if (event.url === previousUrl) {
      return;
    }
    if (currentView === 'webview' && previousUrl && shouldRecreateBrowserForUrl(event.url, previousUrl)) {
      currentUrl = previousUrl;
      void navigate(event.url, { pushHistory: false });
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

  function decodeUrlComponent(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function decodePath(rawPath: string): string {
    const segments = rawPath
      .split('/')
      .filter(Boolean)
      .map(decodeUrlComponent);
    return segments.length > 0 ? `/${segments.join('/')}` : '/';
  }

  /** Parse htree://{self|npub}/treename/path, legacy htree://npub.treename/path, or htree://nhash/path. */
  function parseHtreeUrl(url: string): {
    host: string;
    nhash?: string;
    npub?: string;
    treename?: string;
    path: string;
    query?: string;
    fragment?: string;
  } | null {
    if (!url.startsWith('htree://')) return null;
    const rest = url.slice('htree://'.length);
    const fragmentIndex = rest.indexOf('#');
    const fragment = fragmentIndex === -1 ? undefined : rest.slice(fragmentIndex + 1);
    const withoutFragment = fragmentIndex === -1 ? rest : rest.slice(0, fragmentIndex);
    const separatorMatch = withoutFragment.match(/[/?]/);
    const separatorIndex = separatorMatch?.index ?? -1;
    const host = separatorIndex === -1 ? withoutFragment : withoutFragment.slice(0, separatorIndex);
    const pathAndQuery = separatorIndex === -1 ? '' : withoutFragment.slice(separatorIndex);
    const queryIndex = pathAndQuery.indexOf('?');
    const rawPath = queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);
    const query = queryIndex === -1 ? undefined : pathAndQuery.slice(queryIndex + 1);

    if (host.startsWith('npub1')) {
      const dotIndex = host.indexOf('.');
      if (dotIndex !== -1) {
        const npub = host.slice(0, dotIndex);
        const treename = decodeUrlComponent(host.slice(dotIndex + 1));
        return { host, npub, treename, path: decodePath(rawPath), query, fragment };
      }

      const pathSegments = rawPath.split('/').filter(Boolean);
      const treename = pathSegments[0] ? decodeUrlComponent(pathSegments[0]) : '';
      const path = pathSegments.length > 1 ? `/${pathSegments.slice(1).map(decodeUrlComponent).join('/')}` : '/';
      return { host, npub: host, treename, path, query, fragment };
    } else if (host === 'self') {
      const pathSegments = rawPath.split('/').filter(Boolean);
      const treename = pathSegments[0] ? decodeUrlComponent(pathSegments[0]) : '';
      const path = pathSegments.length > 1 ? `/${pathSegments.slice(1).map(decodeUrlComponent).join('/')}` : '/';
      return { host, treename, path, query, fragment };
    } else if (host.startsWith('nhash1')) {
      return { host, nhash: host, path: decodePath(rawPath), query, fragment };
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

  function clearBlankSuggestedTreeRecoveryTimer() {
    if (blankSuggestedTreeRecoveryTimer) {
      clearTimeout(blankSuggestedTreeRecoveryTimer);
      blankSuggestedTreeRecoveryTimer = null;
    }
  }

  function clearChildLoadStallRecoveryTimer() {
    if (childLoadStallRecoveryTimer) {
      clearTimeout(childLoadStallRecoveryTimer);
      childLoadStallRecoveryTimer = null;
    }
  }

  function shouldRefreshBuiltInAppTreeRoot(url: string): boolean {
    const htree = parseHtreeUrl(url);
    return isBuiltInIrisApp(htree?.npub, htree?.treename);
  }

  function hasChildDiagnosticsSnapshot(): boolean {
    return !!childDocumentTitle.trim() ||
      !!childBodyText.trim() ||
      !!childMediaSummary.trim() ||
      !!childLastError.trim();
  }

  function shouldUsePlainLoopbackTransport(url: string, preferPlainLoopbackHost: boolean): boolean {
    return preferPlainLoopbackHost || plainLoopbackFallbackScopes.has(browserIsolationScope(url));
  }

  function scheduleHtreeLoadStallRecovery(url: string) {
    clearChildLoadStallRecoveryTimer();
    if (!parseHtreeUrl(url)) return;
    if (plainLoopbackFallbackScopes.has(browserIsolationScope(url))) return;

    const scheduledUrl = url;
    childLoadStallRecoveryTimer = setTimeout(() => {
      childLoadStallRecoveryTimer = null;
      if (
        currentView !== 'webview' ||
        currentUrl !== scheduledUrl ||
        childPageLoadState !== 'started' ||
        hasChildDiagnosticsSnapshot()
      ) {
        return;
      }
      void recoverHtreeWebview(scheduledUrl, {
        reason: 'stalled-start',
        preferPlainLoopbackHost: true,
      });
    }, HTREE_LOAD_STALL_RECOVERY_DELAY_MS);
  }

  function resetChildDiagnostics(loadState: string = 'idle', loadUrl: string = '') {
    clearBlankSuggestedTreeRecoveryTimer();
    clearChildLoadStallRecoveryTimer();
    childPageLoadState = loadState;
    childPageLoadUrl = loadUrl;
    childDocumentTitle = '';
    childBodyText = '';
    childMediaSummary = '';
    childLastError = '';
  }

  async function destroyChildWebview() {
    // Always try to close, regardless of tracked state
    try {
      await closeWebview(CHILD_LABEL);
    } catch {
      // Webview might not exist, that's fine
    }
    setChildWebviewReady(false);
    childUsesPlainLoopbackTransport = false;
    resetChildDiagnostics();
    scheduleAutomationStateSync();
  }

  function browserViewportInsets() {
    const dropdownHeight = showDropdown ? (dropdownEl?.offsetHeight ?? 0) : 0;
    const mobileMenuHeight = showMobileMenu ? (mobileMenuEl?.offsetHeight ?? 0) : 0;
    const safeAreaTop = safeAreaTopInsetEl?.offsetHeight ?? 0;

    if (isCompactToolbar) {
      const overlayHeight = Math.max(dropdownHeight, mobileMenuHeight);
      return {
        top: safeAreaTop,
        bottom: toolbarHeight + (overlayHeight > 0 ? overlayHeight + 8 : 0),
      };
    }

    return {
      top: toolbarHeight,
      bottom: 0,
    };
  }

  /** Open a URL in the child webview. */
  async function navigate(url: string, options: NavigateOptions = {}) {
    const {
      pushHistory = true,
      preferPlainLoopbackHost = false,
    } = options;
    const htree = parseHtreeUrl(url);
    const usePlainLoopbackTransport = htree
      ? shouldUsePlainLoopbackTransport(url, preferPlainLoopbackHost)
      : false;

    // Destroy existing child webview when switching origins or entering webview
    if (g.__irisChildReady) {
      if (
        currentView !== 'webview' ||
        shouldRecreateBrowserForUrl(url, currentUrl) ||
        (htree && usePlainLoopbackTransport)
      ) {
        await destroyChildWebview();
      }
    }

    ignoreLocationEvents++;
    webviewNavDepth = 0;
    webviewFwdAvail = 0;

    currentView = 'webview';
    currentUrl = url;
    resetChildDiagnostics('started', url);
    await tick();

    const x = 0;
    const { top, bottom } = browserViewportInsets();
    const y = top;
    const width = window.innerWidth;
    const height = Math.max(0, window.innerHeight - top - bottom);

    if (htree?.npub && htree.treename && isBuiltInIrisApp(htree.npub, htree.treename)) {
      // Built-in apps are released independently of the shell. Always drop any
      // cached mutable root first so the daemon resolves the current app build.
      await clearTreeRootCache(htree.npub, htree.treename, null, null)
        .catch((error) => {
          console.warn('[Iris] failed to clear built-in app tree root cache:', error);
        });
    }

    if (!g.__irisChildReady) {
      try {
        if (htree) {
          await createHtreeWebview(
            CHILD_LABEL,
            htree,
            x,
            y,
            width,
            height,
            usePlainLoopbackTransport,
          );
          childUsesPlainLoopbackTransport = usePlainLoopbackTransport;
        } else {
          await createNip07Webview(CHILD_LABEL, url, x, y, width, height);
          childUsesPlainLoopbackTransport = false;
        }
        setChildWebviewReady(true);
        scheduleWebviewBoundsUpdate();
        scheduleAutomationStateSync();
      } catch (e) {
        const createError = formatWebviewError(e);
        if (!shouldRetryNavigateAfterCreateFailure(createError)) {
          console.warn('[Iris] create webview failed:', createError);
          setChildWebviewError(createError);
          return;
        }
        console.warn('[Iris] create webview failed, trying navigate:', createError);
        try {
          await navigateWebview(CHILD_LABEL, url);
          childUsesPlainLoopbackTransport = false;
          setChildWebviewReady(true);
          scheduleWebviewBoundsUpdate();
          scheduleAutomationStateSync();
        } catch (e2) {
          console.error('[Iris] navigate also failed:', e2);
          setChildWebviewError(e2);
          return;
        }
      }
    } else {
      await navigateWebview(CHILD_LABEL, url);
      childUsesPlainLoopbackTransport = false;
      scheduleWebviewBoundsUpdate();
    }

    scheduleHtreeLoadStallRecovery(url);

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
    showMobileMenu = false;
    await destroyChildWebview();
    currentView = 'launcher';
    currentUrl = '';
    addressValue = '';
    webviewNavDepth = 0;
    webviewFwdAvail = 0;
  }

  function goSettings() {
    showMobileMenu = false;
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
    showMobileMenu = false;
    if (currentView === 'webview' && currentUrl && !childWebviewReady) {
      await navigate(currentUrl, { pushHistory: false });
      return;
    }
    if (currentView === 'webview' && childWebviewReady) {
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

  function handlePageLoadEvent(event: WebviewPageLoadEvent) {
    if (event.label !== CHILD_LABEL) return;
    childPageLoadState = event.event;
    childPageLoadUrl = event.url;
    if (event.event === 'started') {
      clearBlankSuggestedTreeRecoveryTimer();
      return;
    }
    clearChildLoadStallRecoveryTimer();
    if (event.event === 'finished' && currentUrl && parseHtreeUrl(currentUrl)) {
      const scheduledUrl = currentUrl;
      clearBlankSuggestedTreeRecoveryTimer();
      blankSuggestedTreeRecoveryTimer = setTimeout(() => {
        blankSuggestedTreeRecoveryTimer = null;
        if (
          currentView !== 'webview' ||
          currentUrl !== scheduledUrl ||
          childPageLoadState !== 'finished' ||
          hasChildDiagnosticsSnapshot()
        ) {
          return;
        }
        void recoverHtreeWebview(scheduledUrl, {
          reason: 'blank',
          preferPlainLoopbackHost: true,
        });
      }, BLANK_SUGGESTED_TREE_RECOVERY_DELAY_MS);
    }
  }

  async function recoverHtreeWebview(url: string, options: {
    reason: string;
    preferPlainLoopbackHost?: boolean;
  }) {
    const htree = parseHtreeUrl(url);
    if (!htree) return;
    const {
      reason,
      preferPlainLoopbackHost = false,
    } = options;

    const attemptKey = `${url}|${reason}`;
    const attempts = treeRootRecoveryAttempts.get(attemptKey) ?? 0;
    if (attempts >= 1) return;
    treeRootRecoveryAttempts.set(attemptKey, attempts + 1);

    try {
      clearBlankSuggestedTreeRecoveryTimer();
      clearChildLoadStallRecoveryTimer();
      if (preferPlainLoopbackHost) {
        plainLoopbackFallbackScopes.add(browserIsolationScope(url));
      }
      await destroyChildWebview();
      await navigate(url, {
        pushHistory: false,
        preferPlainLoopbackHost,
      });
    } catch (error) {
      console.warn('[Iris] failed to recover htree webview:', error);
    }
  }

  async function maybeRecoverSuggestedTreeRoot(url: string, bodyText: string) {
    if (!RECOVERABLE_TREE_BODY_TEXTS.has(bodyText.trim())) return;
    if (!shouldRefreshBuiltInAppTreeRoot(url)) return;
    await recoverHtreeWebview(url, {
      reason: bodyText.trim(),
      preferPlainLoopbackHost: true,
    });
  }

  function handleDiagnosticEvent(event: WebviewDiagnosticEvent) {
    if (event.label !== CHILD_LABEL) return;
    if (event.title) childDocumentTitle = event.title;
    if (event.bodyText) childBodyText = event.bodyText;
    if (event.mediaSummary) childMediaSummary = event.mediaSummary;
    if (event.error && isFatalChildDiagnosticError(event.error, event.source)) {
      childLastError = event.error;
    }
    if (event.bodyText && currentUrl) {
      void maybeRecoverSuggestedTreeRoot(currentUrl, event.bodyText);
    }
  }

  async function handleDeleteHistoryItem(event: MouseEvent, path: string) {
    event.stopPropagation();
    await deleteHistoryEntry(path);
    dropdownItems = dropdownItems.filter(item => item.path !== path);
  }

  function handleAddressFocus() {
    showMobileMenu = false;
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

  function dismissDropdown() {
    if (blurTimer) {
      clearTimeout(blurTimer);
      blurTimer = null;
    }
    isAddressFocused = false;
    closeDropdown();
    addressInputEl?.blur();
  }

  function scheduleWebviewBoundsUpdate() {
    if (boundsRaf !== null) cancelAnimationFrame(boundsRaf);
    boundsRaf = requestAnimationFrame(async () => {
      boundsRaf = null;
      if (currentView !== 'webview' || !childWebviewReady) return;
      const { top, bottom } = browserViewportInsets();
      const height = Math.max(0, window.innerHeight - top - bottom);
      try {
        await setWebviewBounds(CHILD_LABEL, 0, top, window.innerWidth, height);
      } catch {
        // If the webview is gone or not ready, ignore.
      }
    });
  }

  function scheduleAutomationStateSync() {
    if (automationSyncRaf !== null) cancelAnimationFrame(automationSyncRaf);
    automationSyncRaf = requestAnimationFrame(() => {
      automationSyncRaf = null;
      automationUpdateState({
        shellReady: true,
        currentView: currentView,
        currentUrl: currentUrl,
        addressValue: addressValue,
        canGoBack: canGoBack,
        canGoForward: canGoForward,
        showDropdown: showDropdown,
        childWebviewReady: childWebviewReady,
        childPageLoadState: childPageLoadState,
        childPageLoadUrl: childPageLoadUrl,
        childDocumentTitle: childDocumentTitle,
        childBodyText: childBodyText,
        childMediaSummary: childMediaSummary,
        childLastError: childLastError,
        historyIndex: historyIndex,
        historyLength: historyStack.length,
      }).catch(() => {
        // Browser dev mode and tests without native commands can ignore this.
      });
    });
  }

  async function handleAutomationCommand(command: AutomationCommandEvent) {
    switch (command.action) {
      case 'open_url': {
        const rawUrl = command.url?.trim();
        if (!rawUrl) return;
        const url = displayToUrl(rawUrl);
        currentUrl = url;
        addressValue = isAddressFocused ? url : urlToDisplay(url);
        await navigate(url);
        return;
      }
      case 'back':
        await goBack();
        return;
      case 'forward':
        await goForward();
        return;
      case 'reload':
        await refresh();
        return;
      case 'home':
        await goHome();
        return;
      case 'settings':
        goSettings();
        return;
      case 'shutdown':
        await automationShutdown();
        return;
      default:
        console.warn('[Iris] unknown automation action:', command.action);
    }
  }

  function handleGlobalKeyDown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      addressInputEl?.focus();
      return;
    }
    if ((event.key === 'Escape' || event.key === 'Esc') && showMobileMenu) {
      event.preventDefault();
      showMobileMenu = false;
      return;
    }
    if ((event.key !== 'Escape' && event.key !== 'Esc') || !showDropdown) return;
    event.preventDefault();
    dismissDropdown();
  }

  function handleGlobalPointerDown(event: PointerEvent) {
    if (!showMobileMenu) return;
    const target = event.target;
    if (!(target instanceof Element)) {
      showMobileMenu = false;
      return;
    }
    if (target.closest('[data-testid="mobile-more-menu"]')) return;
    if (target.closest('button[title="More"]')) return;
    showMobileMenu = false;
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
      await navigate(historyStack[historyIndex], { pushHistory: false });
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
      await navigate(historyStack[historyIndex], { pushHistory: false });
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

  $effect(() => {
    currentView;
    currentUrl;
    addressValue;
    canGoBack;
    canGoForward;
    showDropdown;
    childPageLoadState;
    childPageLoadUrl;
    childDocumentTitle;
    childBodyText;
    childMediaSummary;
    childLastError;
    historyIndex;
    historyStack.length;
    scheduleAutomationStateSync();
  });

  $effect(() => {
    toolbarHeight;
    scheduleWebviewBoundsUpdate();
  });

  onMount(async () => {
    const unlistenLocation = await onChildWebviewLocation(handleLocationChange);
    const unlistenPageLoad = await onChildWebviewPageLoad(handlePageLoadEvent);
    const unlistenDiagnostic = await onChildWebviewDiagnostic(handleDiagnosticEvent);
    const unlistenAutomation = await onAutomationCommand((command) => {
      handleAutomationCommand(command).catch((error) => {
        console.warn('[Iris] automation command failed:', error);
      });
    });
    try {
      const pendingDeepLinks = await deepLinkFrontendReady();
      for (const url of pendingDeepLinks) {
        await handleAutomationCommand({ action: 'open_url', url });
      }
    } catch (error) {
      console.warn('[Iris] deep-link initialization failed:', error);
    }
    syncToolbarMode();
    scheduleAutomationStateSync();
    window.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('pointerdown', handleGlobalPointerDown);
    window.addEventListener('resize', syncToolbarMode);
    window.addEventListener('resize', scheduleWebviewBoundsUpdate);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
      window.removeEventListener('pointerdown', handleGlobalPointerDown);
      window.removeEventListener('resize', syncToolbarMode);
      window.removeEventListener('resize', scheduleWebviewBoundsUpdate);
      if (automationSyncRaf !== null) cancelAnimationFrame(automationSyncRaf);
      unlistenLocation();
      unlistenPageLoad();
      unlistenDiagnostic();
      unlistenAutomation();
    };
  });
</script>

<div class="h-[100dvh] max-h-[100dvh] flex flex-col overscroll-none overflow-hidden bg-surface-0">
  <div
    bind:this={safeAreaTopInsetEl}
    aria-hidden="true"
    class="pointer-events-none fixed left-0 top-0 h-0 w-0 overflow-hidden opacity-0"
    style="padding-top: env(safe-area-inset-top, 0px);"
  ></div>
  <!-- Browser chrome -->
  {#if isCompactToolbar}
    <div
      bind:offsetHeight={toolbarHeight}
      data-testid="toolbar"
      data-tauri-drag-region
      class="order-2 relative shrink-0 border-t border-surface-2 bg-surface-1 px-3 pt-2"
      style="padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);"
    >
      {#if showMobileMenu && !isAddressFocused}
        <div
          bind:this={mobileMenuEl}
          data-testid="mobile-more-menu"
          data-tauri-drag-region="false"
          class="absolute bottom-full right-3 mb-2 w-52 overflow-hidden rounded-2xl bg-surface-1 b-1 b-solid b-surface-3 shadow-lg"
        >
          <button
            data-tauri-drag-region="false"
            class="w-full flex items-center justify-between px-4 py-3 text-left text-sm text-text-1 hover:bg-surface-2 transition-colors"
            onclick={async () => {
              showMobileMenu = false;
              await goHome();
            }}
          >
            <span>Home</span>
            <span class="i-lucide-home text-base text-text-3"></span>
          </button>
          <button
            data-tauri-drag-region="false"
            class="w-full flex items-center justify-between px-4 py-3 text-left text-sm text-text-1 hover:bg-surface-2 transition-colors disabled:opacity-40"
            onclick={async () => {
              showMobileMenu = false;
              await goForward();
            }}
            disabled={!canGoForward}
          >
            <span>Forward</span>
            <span class="i-lucide-chevron-right text-base text-text-3"></span>
          </button>
          {#if currentUrl}
            <button
              data-tauri-drag-region="false"
              class="w-full flex items-center justify-between px-4 py-3 text-left text-sm text-text-1 hover:bg-surface-2 transition-colors"
              onclick={async () => {
                showMobileMenu = false;
                await refresh();
              }}
            >
              <span>Refresh</span>
              <span class="i-lucide-refresh-cw text-base text-text-3"></span>
            </button>
          {/if}
          <button
            data-tauri-drag-region="false"
            class="w-full flex items-center justify-between px-4 py-3 text-left text-sm text-text-1 hover:bg-surface-2 transition-colors"
            onclick={() => {
              showMobileMenu = false;
              goSettings();
            }}
          >
            <span>Settings</span>
            <span class="i-lucide-settings text-base text-text-3"></span>
          </button>
        </div>
      {/if}

      <div data-tauri-drag-region class="flex items-center gap-2">
        {#if !isAddressFocused}
          <button
            data-tauri-drag-region="false"
            class="btn-circle btn-ghost shrink-0"
            class:opacity-40={!canGoBack}
            onclick={goBack}
            disabled={!canGoBack}
            title="Back"
          >
            <span class="i-lucide-chevron-left text-lg"></span>
          </button>
        {/if}

        <div data-tauri-drag-region class="flex-1 min-w-0 relative">
          <div
            data-testid="address-bar"
            data-tauri-drag-region="false"
            class="w-full min-w-0 flex items-center gap-2 rounded-full bg-surface-0 b-1 b-solid b-surface-3 px-4 py-2 transition-all {isAddressFocused ? 'b-accent' : ''}"
          >
            {#if currentUrl && !isAddressFocused}
              <button
                data-tauri-drag-region="false"
                class="shrink-0 text-text-3 hover:text-text-1"
                onclick={refresh}
                title={isChildLoading ? 'Loading' : 'Refresh'}
              >
                {#if isChildLoading}
                  <span class="i-lucide-loader-circle text-sm animate-spin"></span>
                {:else}
                  <span class="i-lucide-refresh-cw text-sm"></span>
                {/if}
              </button>
            {/if}
            <span data-tauri-drag-region="false" class="i-lucide-search text-sm text-muted shrink-0"></span>
            <input
              type="text"
              data-tauri-drag-region="false"
              autocorrect="off"
              autocapitalize="none"
              autocomplete="off"
              bind:this={addressInputEl}
              bind:value={addressValue}
              onfocus={handleAddressFocus}
              onblur={handleAddressBlur}
              onbeforeinput={handleAddressBeforeInput}
              onkeypress={handleAddressKeyPress}
              oninput={handleAddressInput}
              onkeydown={handleAddressKeyDown}
              placeholder="Search or enter address"
              spellcheck={false}
              class="bg-transparent border-none outline-none text-sm text-text-1 placeholder:text-muted flex-1 min-w-0 text-left"
            />
            {#if !isAddressFocused}
              <button
                data-tauri-drag-region="false"
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
            {/if}
          </div>

          {#if showDropdown && dropdownItems.length > 0}
            <div
              bind:this={dropdownEl}
              class="absolute bottom-full left-0 right-0 mb-2 bg-surface-1 b-1 b-solid b-surface-3 rounded-lg overflow-hidden z-50 max-h-80 overflow-y-auto"
              role="listbox"
            >
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

        {#if !isAddressFocused}
          <button
            data-tauri-drag-region="false"
            class="btn-circle btn-ghost shrink-0"
            onclick={() => { showMobileMenu = !showMobileMenu; }}
            title="More"
          >
            <span class="i-lucide-ellipsis text-lg"></span>
          </button>
        {/if}
      </div>
    </div>
  {:else}
    <div
      bind:offsetHeight={toolbarHeight}
      data-testid="toolbar"
      data-tauri-drag-region
      class="h-12 shrink-0 flex items-center gap-2 px-3 bg-surface-1 border-b border-surface-2"
      style={`padding-left: ${DESKTOP_TRAFFIC_LIGHTS_PADDING}px;`}
    >
      <div data-tauri-drag-region class="flex items-center gap-1 shrink-0">
        <button
          data-tauri-drag-region="false"
          class="btn-circle btn-ghost"
          class:opacity-40={!canGoBack}
          onclick={goBack}
          disabled={!canGoBack}
          title="Back"
        >
          <span class="i-lucide-chevron-left text-lg"></span>
        </button>
        <button
          data-tauri-drag-region="false"
          class="btn-circle btn-ghost"
          class:opacity-40={!canGoForward}
          onclick={goForward}
          disabled={!canGoForward}
          title="Forward"
        >
          <span class="i-lucide-chevron-right text-lg"></span>
        </button>
        <button data-tauri-drag-region="false" class="btn-circle btn-ghost" onclick={goHome} title="Home">
          <span class="i-lucide-home text-lg"></span>
        </button>
      </div>

      <div data-tauri-drag-region class="flex flex-1 min-w-0 relative justify-center">
        <div
          data-testid="address-bar"
          data-tauri-drag-region="false"
          class="w-full min-w-0 max-w-lg flex items-center gap-2 px-3 py-1 rounded-full bg-surface-0 b-1 b-solid b-surface-3 transition-colors {isAddressFocused ? 'b-accent' : ''}"
        >
          {#if currentUrl}
            <button
              data-tauri-drag-region="false"
              class="shrink-0 text-text-3 hover:text-text-1"
              onclick={refresh}
              title={isChildLoading ? 'Loading' : 'Refresh'}
            >
              {#if isChildLoading}
                <span class="i-lucide-loader-circle text-sm animate-spin"></span>
              {:else}
                <span class="i-lucide-refresh-cw text-sm"></span>
              {/if}
            </button>
          {/if}
          <span data-tauri-drag-region="false" class="i-lucide-search text-sm text-muted shrink-0"></span>
          <input
            type="text"
            data-tauri-drag-region="false"
            autocorrect="off"
            autocapitalize="none"
            autocomplete="off"
            bind:this={addressInputEl}
            bind:value={addressValue}
            onfocus={handleAddressFocus}
            onblur={handleAddressBlur}
            onbeforeinput={handleAddressBeforeInput}
            onkeypress={handleAddressKeyPress}
            oninput={handleAddressInput}
            onkeydown={handleAddressKeyDown}
            placeholder="Search or enter address"
            spellcheck={false}
            class="bg-transparent border-none outline-none text-sm text-text-1 placeholder:text-muted flex-1 min-w-0 text-center"
          />
          <button
            data-tauri-drag-region="false"
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
          <div
            bind:this={dropdownEl}
            class="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-full max-w-lg bg-surface-1 b-1 b-solid b-surface-3 rounded-lg overflow-hidden z-50 max-h-80 overflow-y-auto"
            role="listbox"
          >
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
        data-tauri-drag-region="false"
        class="btn-circle btn-ghost shrink-0"
        onclick={goSettings}
        title="Settings"
      >
        <span class="i-lucide-settings text-lg"></span>
      </button>
    </div>
  {/if}

  <!-- Content area -->
  <main class="min-h-0 flex-1 flex flex-col {isCompactToolbar ? 'order-1' : ''}">
    {#if currentView === 'launcher'}
      <AppLauncher
        onnavigate={(url) => navigate(url)}
      />
    {:else if currentView === 'settings'}
      <Settings onnavigate={(url) => navigate(url)} />
    {:else if !childWebviewReady || childLastError}
      <section class="flex flex-1 items-center justify-center p-6">
        <div
          data-testid={childLastError ? 'webview-error' : 'webview-loading'}
          class="w-full max-w-md rounded-3xl border border-surface-3 bg-surface-1 px-5 py-6 text-center shadow-lg"
        >
          <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-text-1">
            <span class={childLastError ? 'i-lucide-triangle-alert text-xl text-warning' : 'i-lucide-loader-circle animate-spin text-xl'}></span>
          </div>
          <h2 class="text-lg font-semibold text-text-1">
            {childLastError ? webviewErrorHeadline(childLastError) : 'Opening page'}
          </h2>
          <p class="mt-2 text-sm text-text-2">
            {childLastError ? webviewErrorDetail(childLastError) : 'Waiting for the embedded page to start.'}
          </p>
          {#if currentUrl}
            <p class="mt-3 break-all text-xs text-text-3">{currentUrl}</p>
          {/if}
          {#if childLastError && webviewErrorDetail(childLastError) !== childLastError}
            <p class="mt-3 break-all text-xs text-text-3">{childLastError}</p>
          {/if}
        </div>
      </section>
    {/if}
    <!-- When currentView === 'webview', child webview overlays this area -->
  </main>
</div>
