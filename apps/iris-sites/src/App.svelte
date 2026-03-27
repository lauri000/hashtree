<script lang="ts">
  import { onMount } from 'svelte';
  import { parseLaunchInput } from './lib/launchInput';
  import { resolveHostedSite } from './lib/siteConfig';
  import { buildIsolatedSiteHref, buildLauncherHref, buildPermalinkHref, isPortalShellHost } from './lib/siteHost';
  import { getMediaClientKey, setupMediaStreaming } from './lib/mediaStreamingSetup';
  import {
    getTreeRootInfo,
    onTreeRootUpdate,
    subscribeTreeRoots,
    unsubscribeTreeRoots,
    type TreeRootInfo,
    type TreeRootUpdate,
  } from './lib/workerClient';
  import {
    getAutoReloadStorageKey,
    isMenuHidden,
    readHashBooleanParam,
    setAutoReload as setAutoReloadParam,
    setMenuHidden,
  } from './lib/runtimeUi';

  const IRIS_OWNER = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';
  const ENSHITTIFIER_NHASH = 'nhash1qqsxyn0g6yyac8ruej7r7j80y2gx6ev5z5flu6ry5h5t3ajju5utzjs9yz7t3p2syr9n5heajlv85uwej232dk5x4zqe8d7ft67y3m5umxr55qjku38';
  const BOOT_STATUS_DELAY_MS = 2500;
  const launcherSuggestions = [
    {
      name: 'MIDI Enshittifier',
      href: `#/${IRIS_OWNER}/enshittifier/index.html`,
      blurb: 'Mutable site route',
    },
    {
      name: 'Iris Files',
      href: `#/${IRIS_OWNER}/files/index.html`,
      blurb: 'Files and trees',
    },
    {
      name: 'Iris Git',
      href: `#/${IRIS_OWNER}/git/index.html`,
      blurb: 'Repos on hashtree',
    },
    {
      name: 'Iris Boards',
      href: `#/${IRIS_OWNER}/boards/index.html`,
      blurb: 'Shared boards',
    },
    {
      name: 'Iris Meet',
      href: `#/${IRIS_OWNER}/meet/index.html`,
      blurb: 'Video rooms',
    },
    {
      name: 'Pinned MIDI',
      href: `#/${ENSHITTIFIER_NHASH}/index.html`,
      blurb: 'Immutable nhash route',
    },
  ] as const;

  let currentSite = $state(resolveCurrentSite());
  let routeHash = $state(typeof window === 'undefined' ? '' : window.location.hash);
  let runtimeReady = $state(false);
  let runtimeError = $state<string | null>(null);
  let runtimeMenuOpen = $state(false);
  let menuHidden = $state(false);
  let copyStatus = $state<'idle' | 'copied' | 'ready'>('idle');
  let autoReloadEnabled = $state(false);
  let updateAvailable = $state(false);
  let showBootStatus = $state(false);
  let iframeLoaded = $state(false);
  let launchInput = $state('');
  let launchError = $state<string | null>(null);
  let launchPending = $state(false);
  let copyStatusTimeoutId = 0;
  let currentTreeRoot = $state<TreeRootInfo | null>(null);

  function resolveCurrentSite() {
    if (typeof window === 'undefined') return null;
    return resolveHostedSite({
      host: window.location.host,
      hash: window.location.hash,
    });
  }

  function encodePath(path: string): string {
    return path
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  function bytesToHex(bytes: Uint8Array | undefined): string {
    return bytes ? Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('') : '';
  }

  function treeRootSignature(record: Pick<TreeRootInfo, 'hash' | 'key'> | Pick<TreeRootUpdate, 'hash' | 'key'>): string {
    return `${bytesToHex(record.hash)}:${bytesToHex(record.key)}`;
  }

  function readAutoReloadPreference(): boolean {
    if (typeof window === 'undefined' || !currentSite) return false;
    const routeOverride = readHashBooleanParam(routeHash, 'reload');
    if (routeOverride !== null) {
      return routeOverride;
    }
    try {
      return window.localStorage.getItem(getAutoReloadStorageKey(currentSite)) === '1';
    } catch {
      return false;
    }
  }

  function writeAutoReloadPreference(enabled: boolean): void {
    if (typeof window === 'undefined' || !currentSite) return;
    try {
      const key = getAutoReloadStorageKey(currentSite);
      if (enabled) {
        window.localStorage.setItem(key, '1');
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {
      // Ignore storage failures.
    }
  }

  function replaceHash(nextHash: string): void {
    if (typeof window === 'undefined') return;
    const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
    window.history.replaceState({}, '', nextUrl);
    routeHash = nextHash;
  }

  function hideRuntimeMenuForCurrentUrl(): void {
    if (typeof window === 'undefined') return;
    replaceHash(setMenuHidden(routeHash, true));
    menuHidden = true;
    runtimeMenuOpen = false;
  }

  function toggleRuntimeMenu(): void {
    runtimeMenuOpen = !runtimeMenuOpen;
  }

  function buildCurrentLauncherHref(): string {
    if (!currentSite) return '';
    const baseHref = buildLauncherHref(currentSite, typeof window !== 'undefined' ? window.location.host : undefined);
    return applyUiRouteParams(baseHref, routeHash);
  }

  function applyUiRouteParams(href: string, sourceHash: string): string {
    if (!href) return href;
    const url = new URL(href, typeof window !== 'undefined' ? window.location.href : 'https://sites.iris.to/');
    let nextHash = setMenuHidden(url.hash, isMenuHidden(sourceHash));
    nextHash = setAutoReloadParam(nextHash, readHashBooleanParam(sourceHash, 'reload'));
    url.hash = nextHash;
    return url.toString();
  }

  async function copyShareUrl(): Promise<void> {
    const href = buildCurrentLauncherHref();
    if (!href || typeof window === 'undefined') return;

    if (copyStatusTimeoutId) {
      window.clearTimeout(copyStatusTimeoutId);
      copyStatusTimeoutId = 0;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(href);
      } else {
        throw new Error('Clipboard API unavailable');
      }
      copyStatus = 'copied';
    } catch {
      window.prompt('Copy share URL', href);
      copyStatus = 'ready';
    }

    copyStatusTimeoutId = window.setTimeout(() => {
      copyStatus = 'idle';
      copyStatusTimeoutId = 0;
    }, 1800);
  }

  function applyPendingUpdate(): void {
    if (typeof window === 'undefined' || !updateAvailable) return;
    updateAvailable = false;
    runtimeMenuOpen = false;
    window.location.reload();
  }

  function handleFrameLoad(): void {
    iframeLoaded = true;
  }

  async function launchFromInput(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (typeof window === 'undefined') return;

    const parsed = parseLaunchInput(launchInput);
    if (!parsed) {
      launchError = 'Enter an nhash or npub/tree route.';
      return;
    }

    launchError = null;
    launchPending = true;

    try {
      const href = await buildIsolatedSiteHref(parsed, window.location.host);
      window.location.href = href;
    } catch (error) {
      launchError = error instanceof Error ? error.message : String(error);
      launchPending = false;
    }
  }

  function handleAutoReloadChange(event: Event): void {
    const target = event.currentTarget as HTMLInputElement | null;
    const checked = !!target?.checked;
    autoReloadEnabled = checked;
    writeAutoReloadPreference(checked);
    replaceHash(setAutoReloadParam(routeHash, checked));
  }

  const iframeSrc = $derived.by(() => {
    if (!currentSite || !runtimeReady) return '';
    const encodedPath = encodePath(currentSite.entryPath || 'index.html');
    const clientKey = getMediaClientKey();
    if (currentSite.kind === 'immutable') {
      return `/htree/${currentSite.nhash}/${encodedPath}?htree_c=${encodeURIComponent(clientKey)}`;
    }
    const encodedTreeName = encodeURIComponent(currentSite.treeName);
    return `/htree/${currentSite.npub}/${encodedTreeName}/${encodedPath}?htree_c=${encodeURIComponent(clientKey)}`;
  });

  const inPortalShell = $derived.by(() => {
    if (typeof window === 'undefined') return false;
    return isPortalShellHost(window.location.host);
  });

  const missingRuntimeTarget = $derived.by(() => !currentSite && !inPortalShell);
  const launcherHref = $derived.by(() => buildCurrentLauncherHref());
  const permalinkHref = $derived.by(() =>
    currentSite
      ? buildPermalinkHref(
          currentSite,
          currentSite.kind === 'mutable' ? currentTreeRoot ?? undefined : undefined,
          typeof window !== 'undefined' ? window.location.host : undefined,
        ) || ''
      : ''
  );
  const showRuntimeMenu = $derived.by(() => Boolean(currentSite && !inPortalShell && !menuHidden));
  const showRuntimeFallback = $derived.by(() => Boolean(runtimeError || showBootStatus));
  const showFrameOverlay = $derived.by(() => Boolean(runtimeError || (!iframeLoaded && showBootStatus)));

  const inspectorLink = $derived.by(() => {
    if (!currentSite) return '';
    const entryPath = currentSite.entryPath || 'index.html';
    if (currentSite.kind === 'immutable') {
      return `htree://${currentSite.nhash}/${entryPath}`;
    }
    return `htree://${currentSite.npub}/${currentSite.treeName}/${entryPath}`;
  });

  onMount(() => {
    const syncRoute = () => {
      const site = resolveCurrentSite();
      currentSite = site;
      routeHash = typeof window !== 'undefined' ? window.location.hash : '';
      runtimeError = null;
      runtimeMenuOpen = false;
      menuHidden = isMenuHidden(routeHash);
      updateAvailable = false;
      currentTreeRoot = null;
      autoReloadEnabled = site ? readAutoReloadPreference() : false;
      if (typeof window !== 'undefined' && isPortalShellHost(window.location.host) && site) {
        void buildIsolatedSiteHref(site, window.location.host)
          .then((href) => {
            const nextHref = applyUiRouteParams(href, routeHash);
            if (window.location.href !== nextHref) {
              window.location.replace(nextHref);
            }
          })
          .catch((error) => {
            runtimeError = error instanceof Error ? error.message : String(error);
          });
      }
    };

    window.addEventListener('hashchange', syncRoute);

    syncRoute();

    void setupMediaStreaming()
      .then((ok) => {
        if (!ok) {
          runtimeError = 'Failed to connect isolated site runtime.';
          return;
        }
        runtimeReady = true;
      })
      .catch((error) => {
        runtimeError = error instanceof Error ? error.message : String(error);
      });

    return () => {
      window.removeEventListener('hashchange', syncRoute);
    };
  });

  $effect(() => {
    if (!currentSite || currentSite.kind !== 'mutable' || inPortalShell || !runtimeReady) {
      updateAvailable = false;
      return;
    }

    const mutableSite = currentSite;

    let disposed = false;
    let currentSignature = '';

    const handleUpdate = (update: TreeRootUpdate) => {
      if (disposed) return;
      if (update.npub !== mutableSite.npub || update.treeName !== mutableSite.treeName) return;

      const nextSignature = treeRootSignature(update);
      if (!currentSignature) {
        currentSignature = nextSignature;
        currentTreeRoot = update;
        return;
      }
      if (nextSignature === currentSignature) return;

      currentSignature = nextSignature;
      if (autoReloadEnabled && typeof window !== 'undefined') {
        window.location.reload();
        return;
      }
      updateAvailable = true;
    };

    const detach = onTreeRootUpdate(handleUpdate);

    void (async () => {
      try {
        await subscribeTreeRoots(mutableSite.npub);
        const initial = await getTreeRootInfo(mutableSite.npub, mutableSite.treeName);
        if (!disposed && initial) {
          currentSignature = treeRootSignature(initial);
          currentTreeRoot = initial;
        }
      } catch (error) {
        if (!disposed) {
          console.warn('[iris-sites] Failed to subscribe to tree root updates', error);
        }
      }
    })();

    return () => {
      disposed = true;
      detach();
      updateAvailable = false;
      void unsubscribeTreeRoots(mutableSite.npub).catch(() => {});
    };
  });

  $effect(() => {
    void iframeSrc;
    iframeLoaded = false;
  });

  $effect(() => {
    if (typeof window === 'undefined') {
      showBootStatus = false;
      return;
    }

    if (runtimeError) {
      showBootStatus = true;
      return;
    }

    if (inPortalShell && currentSite) {
      showBootStatus = false;
      const timeoutId = window.setTimeout(() => {
        showBootStatus = true;
      }, BOOT_STATUS_DELAY_MS);
      return () => window.clearTimeout(timeoutId);
    }

    if (currentSite && !inPortalShell && !iframeLoaded) {
      showBootStatus = false;
      const timeoutId = window.setTimeout(() => {
        showBootStatus = true;
      }, BOOT_STATUS_DELAY_MS);
      return () => window.clearTimeout(timeoutId);
    }

    showBootStatus = false;
  });
</script>

<svelte:head>
  <title>{currentSite ? `${currentSite.title} · iris sites` : 'iris sites'}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

{#if missingRuntimeTarget}
  <main class="screen">
    <section class="card">
      <p class="eyebrow">Unknown Site</p>
      <h1>This host needs a valid `sites.iris.to` hash route.</h1>
      <p class="copy">
        Open a launcher URL from <code>https://sites.iris.to</code> with an immutable
        <code>nhash</code> or mutable <code>npub/tree</code> route.
      </p>
    </section>
  </main>
{:else if !currentSite}
  <main class="screen">
    <section class="card">
      <p class="eyebrow">Decentralized CDN</p>
      <h1>Open hashtree sites on their own origin.</h1>
      <p class="copy">
        Paste an <code>nhash</code>, <code>npub/tree</code>, or share URL below.
        <code>iris sites</code> launches each site on its own browser origin.
      </p>
      <form class="launcher-form" onsubmit={launchFromInput}>
        <label class="launcher-label" for="site-route">Launch a site</label>
        <div class="launcher-row">
          <input
            id="site-route"
            name="site-route"
            class="launcher-input"
            type="text"
            bind:value={launchInput}
            placeholder="nhash1... or npub1.../enshittifier"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <button class="launcher-button" type="submit" disabled={launchPending}>
            {launchPending ? 'Launching…' : 'Launch'}
          </button>
        </div>
        <p class="launcher-help">Paste an <code>nhash</code>, <code>npub/tree</code>, or share URL.</p>
        {#if launchError}
          <p class="launcher-error">{launchError}</p>
        {/if}
      </form>
      <div class="suggestions">
        {#each launcherSuggestions as suggestion}
          <a class="suggestion" href={suggestion.href}>
            <span class="suggestion-name">{suggestion.name}</span>
            <span class="suggestion-blurb">{suggestion.blurb}</span>
          </a>
        {/each}
      </div>
    </section>
  </main>
{:else if inPortalShell}
  <main class="screen">
    {#if showRuntimeFallback}
      <section class="overlay">
        <p class="eyebrow">{runtimeError ? 'Runtime Error' : 'Launching'}</p>
        <p class="copy">{runtimeError ?? 'Opening the isolated origin…'}</p>
      </section>
    {/if}
  </main>
{:else}
  <main class="frame-screen">
    {#if iframeSrc}
      <iframe
        src={iframeSrc}
        class:site-frame-ready={iframeLoaded}
        class="site-frame"
        title={currentSite.title}
        onload={handleFrameLoad}
      ></iframe>
    {/if}

    {#if !iframeSrc || showFrameOverlay}
      <section class="overlay">
        <p class="eyebrow">{runtimeError ? 'Runtime Error' : 'Still Loading'}</p>
        <p class="copy">{runtimeError ?? 'This site is taking longer than usual to start.'}</p>
        {#if runtimeError}
          <a class="link" href={inspectorLink}>{inspectorLink}</a>
        {/if}
      </section>
    {/if}
  </main>
{/if}

{#if showRuntimeMenu}
  <div class="runtime-menu-shell">
    {#if runtimeMenuOpen}
      <section class="runtime-menu-panel">
        <div class="runtime-menu-header">
          <div class="runtime-menu-title">{currentSite?.title}</div>
          <a class="runtime-menu-home-link" href="https://sites.iris.to/">iris sites</a>
        </div>

        {#if updateAvailable}
          <button
            class="runtime-menu-item runtime-menu-item-primary"
            type="button"
            onclick={applyPendingUpdate}
          >
            Update Now
          </button>
        {/if}

        {#if currentSite?.kind === 'mutable'}
          {#if currentSite?.kind === 'mutable' && permalinkHref}
            <a class="runtime-menu-item" href={permalinkHref}>Permalink</a>
          {/if}

          <label class="runtime-menu-toggle">
            <span class="runtime-menu-toggle-label">Auto-reload on updates</span>
            <input type="checkbox" checked={autoReloadEnabled} onchange={handleAutoReloadChange} />
          </label>
        {/if}

        <button class="runtime-menu-item runtime-menu-item-muted" type="button" onclick={hideRuntimeMenuForCurrentUrl}>
          Hide Menu For This URL
        </button>

        <button
          class="runtime-menu-link-button"
          type="button"
          onclick={copyShareUrl}
          aria-label="Copy sites launcher URL"
        >
          <span class="runtime-menu-link-text">{launcherHref}</span>
          <span class="runtime-menu-link-affordance" data-state={copyStatus}>
            {#if copyStatus === 'idle'}
              <svg
                class="runtime-menu-copy-icon"
                viewBox="0 0 16 16"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M5.5 2.5h6a2 2 0 0 1 2 2v6h-1.5v-6a.5.5 0 0 0-.5-.5h-6zM3 5.5a2 2 0 0 1 2-2h4.5a2 2 0 0 1 2 2V10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm2-.5a.5.5 0 0 0-.5.5V10a.5.5 0 0 0 .5.5h4.5A.5.5 0 0 0 10 10V5.5a.5.5 0 0 0-.5-.5z"
                  fill="currentColor"
                ></path>
              </svg>
            {:else}
              <span class="runtime-menu-copy-label">
                {copyStatus === 'copied' ? 'Copied' : 'Ready'}
              </span>
            {/if}
          </span>
        </button>
      </section>
    {/if}

    <button
      class="runtime-menu-button"
      type="button"
      aria-expanded={runtimeMenuOpen}
      onclick={toggleRuntimeMenu}
    >
      <span>iris sites</span>
      {#if updateAvailable}
        <span class="runtime-menu-indicator"></span>
      {/if}
    </button>
  </div>
{/if}

<style>
  :global(html, body, #app) {
    margin: 0;
    width: 100%;
    min-height: 100%;
    background: #07070a;
    color: #f3f3f4;
    font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
  }

  .screen,
  .frame-screen {
    min-height: 100vh;
    background:
      radial-gradient(circle at top, rgba(96, 165, 250, 0.18), transparent 34%),
      linear-gradient(180deg, #0b1020 0%, #07070a 58%, #050507 100%);
  }

  .screen {
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .card,
  .overlay {
    width: min(720px, 100%);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 24px;
    background: rgba(10, 12, 20, 0.82);
    backdrop-filter: blur(24px);
    box-shadow: 0 20px 80px rgba(0, 0, 0, 0.35);
    padding: 28px;
  }

  .frame-screen {
    padding: 0;
  }

  .overlay {
    margin: 24px;
  }

  .eyebrow {
    margin: 0 0 8px;
    font-size: 12px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #8de1c0;
  }

  h1 {
    margin: 0;
    font-size: clamp(2rem, 5vw, 3.2rem);
    line-height: 1;
  }

  .copy {
    margin: 16px 0 0;
    font-size: 1rem;
    line-height: 1.6;
    color: rgba(243, 243, 244, 0.78);
  }

  .launcher-form {
    margin-top: 24px;
  }

  .launcher-label {
    display: block;
    margin-bottom: 10px;
    font-size: 0.94rem;
    font-weight: 600;
  }

  .launcher-row {
    display: flex;
    align-items: stretch;
    gap: 10px;
  }

  .launcher-input {
    flex: 1;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.05);
    color: inherit;
    font: inherit;
    padding: 14px 16px;
    outline: none;
  }

  .launcher-input:focus {
    border-color: rgba(141, 225, 192, 0.58);
    box-shadow: 0 0 0 3px rgba(141, 225, 192, 0.15);
  }

  .launcher-button {
    border: 0;
    border-radius: 14px;
    background: linear-gradient(135deg, #8de1c0 0%, #8fb7ff 100%);
    color: #081018;
    font: inherit;
    font-weight: 700;
    padding: 0 18px;
    cursor: pointer;
  }

  .launcher-button:disabled {
    cursor: wait;
    opacity: 0.75;
  }

  .launcher-help,
  .launcher-error {
    margin: 10px 0 0;
    font-size: 0.88rem;
  }

  .launcher-help {
    color: rgba(243, 243, 244, 0.62);
  }

  .launcher-error {
    color: #f7a8a8;
  }

  .suggestions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-top: 22px;
  }

  .suggestion {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    text-decoration: none;
    transition: background 160ms ease, transform 160ms ease, border-color 160ms ease;
  }

  .suggestion:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(168, 209, 255, 0.28);
    transform: translateY(-1px);
  }

  .suggestion-name {
    font-size: 0.98rem;
    font-weight: 600;
  }

  .suggestion-blurb {
    font-size: 0.86rem;
    color: rgba(243, 243, 244, 0.66);
  }

  code {
    font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
    font-size: 0.92em;
  }

  .link {
    display: inline-block;
    margin-top: 18px;
    color: #a8d1ff;
    text-decoration: none;
    word-break: break-all;
  }

  .site-frame {
    width: 100%;
    height: 100vh;
    border: 0;
    background: #07070a;
    opacity: 0;
    transition: opacity 180ms ease;
  }

  .site-frame-ready {
    opacity: 1;
  }

  .runtime-menu-shell {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 12px;
  }

  .runtime-menu-panel {
    width: min(320px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(6, 9, 17, 0.92);
    box-shadow: 0 16px 50px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(24px);
  }

  .runtime-menu-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .runtime-menu-title {
    min-width: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }

  .runtime-menu-home-link {
    flex: 0 0 auto;
    color: rgba(168, 209, 255, 0.9);
    font-size: 0.8rem;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }

  .runtime-menu-home-link:hover {
    color: #c6e0ff;
  }

  .runtime-menu-item,
  .runtime-menu-link-button,
  .runtime-menu-toggle {
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    text-decoration: none;
    font: inherit;
  }

  .runtime-menu-item,
  .runtime-menu-toggle {
    width: 100%;
    padding: 11px 12px;
    text-align: left;
    cursor: pointer;
  }

  .runtime-menu-link-button {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 12px;
    text-align: left;
    cursor: pointer;
  }

  .runtime-menu-link-text {
    flex: 1;
    min-width: 0;
    font-size: 0.79rem;
    line-height: 1.4;
    color: rgba(168, 209, 255, 0.9);
    word-break: break-all;
  }

  .runtime-menu-link-affordance {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    width: 3.9rem;
    height: 1.25rem;
    color: rgba(243, 243, 244, 0.88);
  }

  .runtime-menu-copy-icon {
    width: 16px;
    height: 16px;
  }

  .runtime-menu-copy-label {
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .runtime-menu-item:hover,
  .runtime-menu-link-button:hover,
  .runtime-menu-toggle:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .runtime-menu-item-muted {
    color: rgba(243, 243, 244, 0.72);
  }

  .runtime-menu-item-primary {
    background: rgba(110, 231, 183, 0.12);
    border-color: rgba(110, 231, 183, 0.2);
    color: #b9f5df;
  }

  .runtime-menu-toggle {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 14px;
  }

  .runtime-menu-toggle-label {
    min-width: 0;
    line-height: 1.35;
  }

  .runtime-menu-toggle input {
    justify-self: end;
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: #6ee7b7;
  }

  .runtime-menu-button {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    border: 0;
    border-radius: 999px;
    padding: 11px 15px;
    background: rgba(6, 9, 17, 0.92);
    color: #f3f3f4;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.32);
  }

  .runtime-menu-button:hover {
    background: rgba(12, 16, 28, 0.96);
  }

  .runtime-menu-indicator {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: #6ee7b7;
    box-shadow: 0 0 0 3px rgba(110, 231, 183, 0.18);
  }

  @media (max-width: 640px) {
    .launcher-row {
      flex-direction: column;
    }

    .runtime-menu-shell {
      right: 12px;
      bottom: 12px;
    }
  }
</style>
