<script lang="ts">
  import Hero from './components/Hero.svelte';
  import FileShare from './components/FileShare.svelte';
  import Developers from './components/Developers.svelte';
  import Footer from './components/Footer.svelte';

  let activeTab = $state<'share' | 'developers'>('share');
</script>

<div class="min-h-full flex flex-col">
  <header class="px-4 py-3 flex items-center justify-between max-w-5xl mx-auto w-full">
    <a href="/" class="flex items-center gap-2 no-underline">
      <span class="text-xl font-bold text-accent font-mono">#tree</span>
    </a>
    <nav class="flex gap-1 bg-surface-1 rounded-lg p-1">
      <button
        class="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
        class:bg-surface-2={activeTab === 'share'}
        class:text-text-1={activeTab === 'share'}
        class:text-text-2={activeTab !== 'share'}
        onclick={() => activeTab = 'share'}
      >
        <span class="i-lucide-upload mr-1.5 text-xs"></span>
        Share Files
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
  </header>

  <main class="flex-1 max-w-5xl mx-auto w-full px-4">
    {#if activeTab === 'share'}
      <Hero />
      <FileShare />
    {:else}
      <Developers />
    {/if}
  </main>

  <Footer />
</div>
