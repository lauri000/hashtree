<script lang="ts">
  import { currentPath, navigate } from '../../lib/router.svelte';
  import NetworkSettings from './NetworkSettings.svelte';
  import StorageSettings from './StorageSettings.svelte';
  import AppSettings from './AppSettings.svelte';

  const tabs = [
    {
      id: 'app',
      label: 'App',
      icon: 'i-lucide-settings-2',
    },
    {
      id: 'storage',
      label: 'Storage',
      icon: 'i-lucide-hard-drive',
    },
    {
      id: 'network',
      label: 'Network',
      icon: 'i-lucide-server',
    },
  ] as const;

  type TabId = (typeof tabs)[number]['id'];

  const DEFAULT_TAB: TabId = 'app';

  function selectTab(id: TabId) {
    navigate(`/settings/${id}`);
  }

  function openSettingsIndex() {
    navigate('/settings');
  }

  let activeTab = $derived.by((): TabId => {
    const path = $currentPath;
    if (path === '/settings') return DEFAULT_TAB;
    if (path.startsWith('/settings/storage')) return 'storage';
    if (path.startsWith('/settings/network')) return 'network';
    if (path.startsWith('/settings/app')) return 'app';
    if (path.startsWith('/settings/servers')) return 'network';
    if (path.startsWith('/settings/p2p')) return 'network';
    return DEFAULT_TAB;
  });

  let isSettingsRootRoute = $derived($currentPath === '/settings');
  let activeItem = $derived(tabs.find((tab) => tab.id === activeTab) ?? tabs[0]);
</script>

<div class="flex min-h-0 flex-1 flex-col bg-surface-1 lg:flex-row">
  <aside
    class={`min-h-0 shrink-0 overflow-auto border-b border-surface-2 bg-surface-1 lg:w-[22rem] lg:border-b-0 lg:border-r ${isSettingsRootRoute ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'}`}
  >
    <div class="w-full px-4 pb-8 pt-6 lg:px-5 lg:py-6">
      <div class="mb-6">
        <h1 class="text-2xl font-semibold text-text-1">Settings</h1>
      </div>

      <div class="overflow-hidden rounded-2xl bg-surface-2 shadow-sm ring-1 ring-surface-3/80">
        {#each tabs as item, index (item.id)}
          <button
            data-testid={`settings-nav-${item.id}`}
            onclick={() => selectTab(item.id)}
            aria-current={activeTab === item.id ? 'page' : undefined}
            class={`relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${activeTab === item.id ? 'bg-surface-3/80' : 'hover:bg-surface-3/40'}`}
          >
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-1 text-text-2">
              <span class={item.icon}></span>
            </span>
            <span class="min-w-0 flex-1 text-sm font-medium text-text-1">{item.label}</span>
            <span class="i-lucide-chevron-right shrink-0 text-base text-text-3"></span>
            {#if index < tabs.length - 1}
              <span class="absolute bottom-0 left-16 right-0 border-b border-surface-3/70"></span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </aside>

  <section class={`min-w-0 flex-1 overflow-auto ${isSettingsRootRoute ? 'hidden lg:block' : 'block'}`}>
    <div class="w-full px-4 pb-8 pt-6 lg:px-8 lg:py-8">
      <div class="mb-6 lg:hidden">
        <button
          class="inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-3"
          onclick={openSettingsIndex}
        >
          <span class="i-lucide-chevron-left text-base"></span>
          <span>Settings</span>
        </button>
      </div>

      <div class="mb-6">
        <h2 class="text-2xl font-semibold text-text-1">{activeItem.label}</h2>
      </div>

      {#if activeTab === 'app'}
        <AppSettings />
      {:else if activeTab === 'storage'}
        <StorageSettings />
      {:else}
        <NetworkSettings />
      {/if}
    </div>
  </section>
</div>
