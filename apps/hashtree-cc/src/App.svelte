<script lang="ts">
  import { isNHash } from '@hashtree/core';
  import Hero from './components/Hero.svelte';
  import FileShare from './components/FileShare.svelte';
  import Developers from './components/Developers.svelte';
  import FileViewer from './components/FileViewer.svelte';
  import Footer from './components/Footer.svelte';

  let activeTab = $state<'share' | 'developers'>('share');

  // Hash-based routing: detect #/nhash1.../filename
  let nhash = $state('');
  let fileName = $state('');

  function parseHash() {
    const hash = window.location.hash;
    if (!hash || hash.length < 3) {
      nhash = '';
      fileName = '';
      return;
    }
    // Format: #/nhash1.../filename.ext
    const parts = hash.slice(2).split('/'); // remove #/
    if (parts.length >= 1 && isNHash(parts[0])) {
      nhash = parts[0];
      fileName = parts.length >= 2 ? decodeURIComponent(parts[1]) : '';
    } else {
      nhash = '';
      fileName = '';
    }
  }

  parseHash();

  $effect(() => {
    const handler = () => parseHash();
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  });
</script>

<div class="min-h-full flex flex-col">
  <header class="px-4 py-3 flex items-center justify-between max-w-5xl mx-auto w-full">
    <a href="/" class="flex items-center gap-2 no-underline" onclick={() => { nhash = ''; fileName = ''; }}>
      <span class="text-xl font-bold text-accent font-mono"># hashtree</span>
    </a>
    {#if !nhash}
      <nav class="flex gap-1 bg-surface-1 rounded-lg p-1">
        <button
          class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
          class:bg-surface-2={activeTab === 'share'}
          class:text-text-1={activeTab === 'share'}
          class:text-text-2={activeTab !== 'share'}
          onclick={() => activeTab = 'share'}
        >
          <span class="i-lucide-upload mr-1.5 text-xs"></span>
          Share Privately
        </button>
        <button
          class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
          class:bg-surface-2={activeTab === 'developers'}
          class:text-text-1={activeTab === 'developers'}
          class:text-text-2={activeTab !== 'developers'}
          onclick={() => activeTab = 'developers'}
        >
          <span class="i-lucide-code mr-1.5 text-xs"></span>
          For Developers
        </button>
      </nav>
    {/if}
  </header>

  <main class="flex-1 max-w-5xl mx-auto w-full px-4">
    {#if nhash}
      <FileViewer {nhash} {fileName} />
    {:else if activeTab === 'share'}
      <Hero />
      <FileShare />
    {:else}
      <Developers />
    {/if}
  </main>

  <Footer />
</div>
