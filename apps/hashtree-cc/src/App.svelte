<script lang="ts">
  import { isNHash } from '@hashtree/core';
  import Hero from './components/Hero.svelte';
  import FileShare from './components/FileShare.svelte';
  import Developers from './components/Developers.svelte';
  import FileViewer from './components/FileViewer.svelte';
  import SettingsPage from './components/SettingsPage.svelte';
  import ConnectivityIndicator from './components/ConnectivityIndicator.svelte';
  import BandwidthIndicator from './components/BandwidthIndicator.svelte';
  import UploadProgressToast from './components/UploadProgressToast.svelte';
  import ShareModal from './components/ShareModal.svelte';
  import Footer from './components/Footer.svelte';
  import { settingsStore } from './lib/settings';

  let route = $state<
    { type: 'share' }
    | { type: 'dev' }
    | { type: 'settings' }
    | { type: 'viewer'; nhash: string; fileName: string }
  >({ type: 'share' });
  let showBandwidthIndicator = $derived($settingsStore.ui.showBandwidthIndicator);
  function parseHash() {
    const hash = window.location.hash;
    if (!hash || hash.length < 3) {
      route = { type: 'share' };
      return;
    }
    const parts = hash.slice(2).split('/'); // remove #/
    if (parts[0] === 'dev') {
      route = { type: 'dev' };
    } else if (parts[0] === 'settings') {
      route = { type: 'settings' };
    } else if (parts.length >= 1 && isNHash(parts[0])) {
      route = { type: 'viewer', nhash: parts[0], fileName: parts.length >= 2 ? parts[1] : '' };
    } else {
      route = { type: 'share' };
    }
  }

  parseHash();

  function navigate(e: MouseEvent) {
    e.preventDefault();
    history.pushState(null, '', '/');
    parseHash();
  }

  $effect(() => {
    const handler = () => parseHash();
    window.addEventListener('hashchange', handler);
    window.addEventListener('popstate', handler);
    return () => {
      window.removeEventListener('hashchange', handler);
      window.removeEventListener('popstate', handler);
    };
  });
</script>

<div class="min-h-full flex flex-col">
  <header class="px-4 py-3 flex flex-col items-center gap-2 max-w-5xl mx-auto w-full">
    <div class="flex items-center justify-between w-full">
      <a href="/" class="flex items-center gap-2 no-underline" onclick={navigate}>
        <span class="text-xl font-bold text-accent font-mono"># hashtree</span>
      </a>
      <div class="flex items-center gap-2">
        {#if showBandwidthIndicator}
          <BandwidthIndicator />
        {/if}
        <ConnectivityIndicator />
      </div>
    </div>
    <div class="flex items-center gap-2">
      {#if route.type === 'share' || route.type === 'dev'}
        <nav class="flex gap-1 bg-surface-1 rounded-lg p-1">
          <a
            href="/"
            class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors no-underline"
            class:bg-surface-2={route.type === 'share'}
            class:text-text-1={route.type === 'share'}
            class:text-text-2={route.type !== 'share'}
            onclick={navigate}
          >
            <span class="i-lucide-upload mr-1.5 text-xs"></span>
            Share Privately
          </a>
          <a
            href="/#/dev"
            class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors no-underline"
            class:bg-surface-2={route.type === 'dev'}
            class:text-text-1={route.type === 'dev'}
            class:text-text-2={route.type !== 'dev'}
          >
            <span class="i-lucide-code mr-1.5 text-xs"></span>
            For Developers
          </a>

        </nav>
      {/if}
    </div>
  </header>

  <main class="flex-1 max-w-5xl mx-auto w-full px-4">
    {#if route.type === 'viewer'}
      <FileViewer nhash={route.nhash} fileName={route.fileName} />
    {:else if route.type === 'dev'}
      <Developers />
    {:else if route.type === 'settings'}
      <SettingsPage />
    {:else}
      <Hero />
      <FileShare />
    {/if}
  </main>

  <Footer />
</div>

<UploadProgressToast />
<ShareModal />
