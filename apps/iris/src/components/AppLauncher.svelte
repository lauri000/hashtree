<script lang="ts">
  import { appsStore, type AppBookmark } from '../stores/apps';

  interface Props {
    onnavigate: (url: string) => void;
  }

  let { onnavigate }: Props = $props();

  const suggestions: AppBookmark[] = [
    { url: 'https://files.iris.to', name: 'Iris Files', icon: '/iris-logo.png', addedAt: 0 },
    { url: 'https://video.iris.to', name: 'Iris Video', icon: '/iris-logo.png', addedAt: 0 },
    { url: 'https://iris.to', name: 'Iris Social', icon: '/iris-logo.png', addedAt: 0 },
  ];

  let favorites = $derived($appsStore);

  function openApp(app: AppBookmark) {
    onnavigate(app.url);
  }

  function removeFromFavorites(url: string) {
    appsStore.remove(url);
  }

  function addToFavorites(app: AppBookmark) {
    appsStore.add({ ...app, addedAt: Date.now() });
  }

  function getInitial(name: string): string {
    return name.charAt(0).toUpperCase();
  }

  function getColor(name: string): string {
    const colors = [
      'bg-orange-500',
      'bg-blue-500',
      'bg-green-500',
      'bg-purple-500',
      'bg-pink-500',
      'bg-yellow-500',
      'bg-red-500',
      'bg-teal-500',
    ];
    return colors[name.charCodeAt(0) % colors.length];
  }

  function getHostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
</script>

<div class="flex-1 p-8 md:p-12 overflow-auto">
  <div class="max-w-3xl mx-auto">
    <!-- Favourites -->
    <section class="mb-10">
      <h2 class="text-lg font-semibold text-text-1 mb-4">Favourites</h2>
      {#if favorites.length === 0}
        <p class="text-text-3 text-sm">No favourites yet. Add apps from suggestions below.</p>
      {:else}
        <div class="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-4">
          {#each favorites as app (app.url)}
            <div class="group relative">
              <button
                class="w-full flex flex-col items-center gap-2"
                onclick={() => openApp(app)}
              >
                <div class="w-14 h-14 rounded-xl {getColor(app.name)} flex items-center justify-center text-white text-xl font-semibold shadow-lg hover:scale-105 transition-transform">
                  {#if app.icon}
                    <img src={app.icon} alt="" class="w-10 h-10 rounded-lg" />
                  {:else}
                    {getInitial(app.name)}
                  {/if}
                </div>
                <span class="text-xs text-text-2 truncate w-full text-center">{app.name}</span>
              </button>
              <button
                class="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-surface-2 text-text-3 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs hover:bg-red-600 hover:text-white"
                onclick={(e) => { e.stopPropagation(); removeFromFavorites(app.url); }}
                title="Remove"
              >
                <span class="i-lucide-x text-xs"></span>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Suggestions -->
    <section>
      <h2 class="text-lg font-semibold text-text-1 mb-4">Suggestions</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {#each suggestions as app (app.url)}
          <div
            role="button"
            tabindex="0"
            class="flex items-center gap-3 p-3 bg-surface-1 hover:bg-surface-2 rounded-xl transition-colors text-left cursor-pointer"
            onclick={() => openApp(app)}
            onkeydown={(e) => e.key === 'Enter' && openApp(app)}
          >
            <div class="w-12 h-12 rounded-xl bg-surface-2 flex items-center justify-center shrink-0">
              {#if app.icon}
                <img src={app.icon} alt="" class="w-8 h-8 rounded-lg" />
              {:else}
                <span class="text-lg font-semibold text-text-2">{getInitial(app.name)}</span>
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-text-1 truncate">{app.name}</div>
              <div class="text-xs text-text-3 truncate">{getHostname(app.url)}</div>
            </div>
            {#if !favorites.some(f => f.url === app.url)}
              <button
                class="shrink-0 p-1 rounded hover:bg-surface-3"
                onclick={(e) => { e.stopPropagation(); addToFavorites(app); }}
                title="Add to favourites"
              >
                <span class="i-lucide-plus text-text-3"></span>
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  </div>
</div>
