<script lang="ts">
  import { onMount } from 'svelte';
  import { resolveHostedSite } from './lib/siteConfig';
  import { buildIsolatedSiteHref, isPortalShellHost } from './lib/siteHost';
  import { getMediaClientKey, setupMediaStreaming } from './lib/mediaStreamingSetup';

  let currentSite = $state(resolveCurrentSite());
  let runtimeReady = $state(false);
  let runtimeError = $state<string | null>(null);
  let portalLaunchHref = $state('');

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
      runtimeError = null;
      if (typeof window !== 'undefined' && isPortalShellHost(window.location.host) && site) {
        void buildIsolatedSiteHref(site, window.location.host)
          .then((href) => {
            portalLaunchHref = href;
            if (window.location.href !== href) {
              window.location.replace(href);
            }
          })
          .catch((error) => {
            runtimeError = error instanceof Error ? error.message : String(error);
          });
      } else {
        portalLaunchHref = '';
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
</script>

<svelte:head>
  <title>{currentSite ? `${currentSite.title} · Iris Sites` : 'Iris Sites'}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

{#if missingRuntimeTarget}
  <main class="screen">
    <section class="card">
      <p class="eyebrow">Unknown Site</p>
      <h1>This isolated host needs a valid hash route or mapped alias.</h1>
      <p class="copy">
        Open a launcher URL from <code>https://sites.iris.to</code> or use an allowlisted alias host.
      </p>
    </section>
  </main>
{:else if !currentSite}
  <main class="screen">
    <section class="card">
      <p class="eyebrow">Isolated Sites</p>
      <h1>Open a hashtree site on its own web origin.</h1>
      <p class="copy">
        Use a hash route like <code>https://sites.iris.to/#/nhash.../index.html</code> or
        <code>https://sites.iris.to/#/npub1.../enshittifier/index.html</code> to launch it on an
        isolated host with its own browser storage.
      </p>
    </section>
  </main>
{:else if inPortalShell}
  <main class="screen">
    <section class="overlay">
      <p class="eyebrow">Launching</p>
      <h1>{currentSite.title}</h1>
      <p class="copy">{runtimeError ?? 'Opening the isolated origin…'}</p>
      {#if portalLaunchHref}
        <a class="link" href={portalLaunchHref}>Continue to isolated site</a>
      {/if}
    </section>
  </main>
{:else}
  <main class="frame-screen">
    {#if iframeSrc}
      <iframe
        src={iframeSrc}
        class="site-frame"
        title={currentSite.title}
      ></iframe>
    {:else}
      <section class="overlay">
        <p class="eyebrow">Starting</p>
        <h1>{currentSite.title}</h1>
        <p class="copy">{runtimeError ?? 'Preparing isolated runtime…'}</p>
        <a class="link" href={inspectorLink}>{inspectorLink}</a>
      </section>
    {/if}
  </main>
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
    background: white;
  }
</style>
