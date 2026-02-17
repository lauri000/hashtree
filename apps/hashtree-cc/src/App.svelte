<script lang="ts">
  import { isNHash } from '@hashtree/core';
  import Hero from './components/Hero.svelte';
  import FileShare from './components/FileShare.svelte';
  import Developers from './components/Developers.svelte';
  import FileViewer from './components/FileViewer.svelte';
  import Footer from './components/Footer.svelte';

  let route = $state<{ type: 'share' } | { type: 'dev' } | { type: 'viewer'; nhash: string; fileName: string }>({ type: 'share' });

  function parseHash() {
    const hash = window.location.hash;
    if (!hash || hash.length < 3) {
      route = { type: 'share' };
      return;
    }
    const parts = hash.slice(2).split('/'); // remove #/
    if (parts[0] === 'dev') {
      route = { type: 'dev' };
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
  <header class="px-4 py-3 flex items-center justify-between max-w-5xl mx-auto w-full">
    <a href="/" class="flex items-center gap-2 no-underline" onclick={navigate}>
      <span class="text-xl font-bold text-accent font-mono"># hashtree</span>
    </a>
    {#if route.type !== 'viewer'}
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
  </header>

  <main class="flex-1 max-w-5xl mx-auto w-full px-4">
    {#if route.type === 'viewer'}
      <FileViewer nhash={route.nhash} fileName={route.fileName} />
    {:else if route.type === 'dev'}
      <Developers />
    {:else}
      <Hero />
      <FileShare />
    {/if}
  </main>

  <Footer />
</div>
