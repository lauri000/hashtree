<script lang="ts">
  import { onMount } from 'svelte';
  import { resolveHostedSite } from './lib/siteConfig';
  import { buildIsolatedSiteHref, isPortalShellHost } from './lib/siteHost';
  import { getMediaClientKey, setupMediaStreaming } from './lib/mediaStreamingSetup';

  const IRIS_OWNER = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';
  const ENSHITTIFIER_NHASH = 'nhash1qqsxyn0g6yyac8ruej7r7j80y2gx6ev5z5flu6ry5h5t3ajju5utzjs9yz7t3p2syr9n5heajlv85uwej232dk5x4zqe8d7ft67y3m5umxr55qjku38';
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
      <p class="eyebrow">Isolated Sites</p>
      <h1>Open content-addressed sites with origin isolation.</h1>
      <p class="copy">
        Use a hash route like <code>https://sites.iris.to/#/nhash.../index.html</code> or
        <code>https://sites.iris.to/#/npub1.../enshittifier/index.html</code> to launch it on a
        separate browser origin with its own storage.
      </p>
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
    background: white;
  }
</style>
