<script lang="ts">
  import type { CID } from '@hashtree/core';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { routeStore } from '../../stores';
  import { nostrStore } from '../../nostr';
  import { createReleasesStore, type ReleaseSummary } from '../../stores/releases';
  import { loadProjectMeta, type ProjectMeta } from '../../stores/projectMeta';

  interface Props {
    npub: string;
    repoName: string;
    repoCid: CID | null;
    readmeContent?: string | null;
  }

  let { npub, repoName, repoCid, readmeContent = null }: Props = $props();

  let route = $derived($routeStore);
  let releasesStore = $derived(createReleasesStore(npub, repoName));
  let releasesState = $derived($releasesStore);
  let isOwner = $derived($nostrStore.npub === npub);
  let visibleReleases = $derived(
    isOwner ? releasesState.items : releasesState.items.filter(release => !release.draft)
  );
  let latestRelease = $derived(visibleReleases[0] ?? null);

  let projectMeta = $state<ProjectMeta | null>(null);
  let projectMetaLoading = $state(false);

  $effect(() => {
    const cid = repoCid;
    projectMeta = null;
    projectMetaLoading = false;
    if (!cid) return;

    let cancelled = false;
    projectMetaLoading = true;
    loadProjectMeta(cid).then(result => {
      if (!cancelled) {
        projectMeta = result;
      }
    }).catch(() => {
      if (!cancelled) {
        projectMeta = null;
      }
    }).finally(() => {
      if (!cancelled) {
        projectMetaLoading = false;
      }
    });

    return () => {
      cancelled = true;
    };
  });

  function extractReadmeLead(content: string | null | undefined): string | null {
    if (!content) return null;

    const lines = content.split('\n');
    const paragraph: string[] = [];
    let inCodeBlock = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        if (paragraph.length > 0) break;
        continue;
      }
      if (inCodeBlock) continue;
      if (!line) {
        if (paragraph.length > 0) break;
        continue;
      }
      if (line.startsWith('#')) continue;
      if (line.startsWith('- ') || /^\d+\.\s/.test(line)) {
        if (paragraph.length > 0) break;
        continue;
      }
      paragraph.push(line);
    }

    if (paragraph.length === 0) return null;
    return paragraph.join(' ').replace(/\s+/g, ' ');
  }

  let aboutText = $derived(projectMeta?.about ?? extractReadmeLead(readmeContent));
  let homepage = $derived(projectMeta?.homepage ?? null);

  function normalizeHref(href: string): string {
    return /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`;
  }

  function formatHomepageLabel(href: string): string {
    return href.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
  }

  function buildReleasesHref(): string {
    const query = new SvelteURLSearchParams();
    if (route.params.get('k')) query.set('k', route.params.get('k')!);
    query.set('tab', 'releases');
    return `#/${npub}/${repoName}?${query.toString()}`;
  }

  function buildReleaseHref(release: ReleaseSummary): string {
    const query = new SvelteURLSearchParams();
    if (route.params.get('k')) query.set('k', route.params.get('k')!);
    query.set('tab', 'releases');
    query.set('id', release.id);
    return `#/${npub}/${repoName}?${query.toString()}`;
  }

  function formatDate(timestamp: number | undefined): string {
    if (!timestamp) return 'unknown';

    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      const hours = Math.floor(diff / (1000 * 60 * 60));
      if (hours === 0) {
        const minutes = Math.max(1, Math.floor(diff / (1000 * 60)));
        return `${minutes}m ago`;
      }
      return `${hours}h ago`;
    }
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return date.toLocaleDateString();
  }
</script>

<aside class="w-full shrink-0 lg:sticky lg:top-4 lg:w-72" data-testid="repo-sidebar">
  <div class="flex flex-col gap-4">
    {#if projectMetaLoading || aboutText || homepage}
      <section class="rounded-lg b-1 b-surface-3 b-solid bg-surface-0 overflow-hidden" data-testid="repo-project-sidebar">
        <div class="flex items-center justify-between gap-3 px-4 py-3 b-b-1 b-b-solid b-b-surface-3">
          <span class="text-sm font-medium text-text-1">About</span>
          <span class="i-lucide-info text-text-3"></span>
        </div>

        <div class="flex flex-col gap-3 px-4 py-4">
          {#if aboutText}
            <p class="text-sm text-text-2 whitespace-pre-wrap">{aboutText}</p>
          {:else if projectMetaLoading}
            <div class="flex items-center gap-2 text-sm text-text-3">
              <span class="i-lucide-loader-2 animate-spin"></span>
              Loading project metadata...
            </div>
          {/if}

          {#if homepage}
            <a
              href={normalizeHref(homepage)}
              target="_blank"
              rel="noreferrer"
              class="inline-flex items-center gap-2 text-sm text-accent hover:underline break-all"
            >
              <span class="i-lucide-globe text-text-3"></span>
              <span>{formatHomepageLabel(homepage)}</span>
            </a>
          {/if}
        </div>
      </section>
    {/if}

    <section class="rounded-lg b-1 b-surface-3 b-solid bg-surface-0 overflow-hidden" data-testid="repo-releases-sidebar">
      <div class="flex items-center justify-between gap-3 px-4 py-3 b-b-1 b-b-solid b-b-surface-3">
        <div class="min-w-0">
          <div class="text-sm font-medium text-text-1">Releases</div>
          <div class="text-xs text-text-3">
            {#if releasesState.loading}
              Loading release summary...
            {:else}
              {visibleReleases.length} release{visibleReleases.length !== 1 ? 's' : ''}
            {/if}
          </div>
        </div>
        <span class="i-lucide-tag text-text-3"></span>
      </div>

      {#if releasesState.loading}
        <div class="flex items-center gap-2 px-4 py-4 text-sm text-text-3">
          <span class="i-lucide-loader-2 animate-spin"></span>
          Loading releases...
        </div>
      {:else if releasesState.error}
        <div class="px-4 py-4 text-sm text-danger">
          {releasesState.error}
        </div>
      {:else if latestRelease}
        <div class="flex flex-col gap-3 px-4 py-4">
          <div class="text-xs font-medium uppercase tracking-wide text-text-3">Latest release</div>
          <a
            href={buildReleaseHref(latestRelease)}
            class="text-sm font-medium text-text-1 hover:text-accent hover:underline"
            data-testid="repo-latest-release-link"
          >
            {latestRelease.title}
          </a>

          <div class="flex flex-wrap items-center gap-2 text-xs text-text-3">
            {#if latestRelease.tag}
              <span class="font-mono rounded bg-surface-2 px-1.5 py-0.5">{latestRelease.tag}</span>
            {/if}
            <span>published {formatDate(latestRelease.published_at ?? latestRelease.created_at)}</span>
          </div>
        </div>
      {:else}
        <div class="px-4 py-4 text-sm text-text-3">
          No releases yet.
        </div>
      {/if}

      <div class="px-4 py-3 b-t-1 b-t-solid b-t-surface-3">
        <a
          href={buildReleasesHref()}
          class="inline-flex items-center gap-2 text-sm text-accent hover:underline"
          data-testid="repo-releases-link"
        >
          <span>View all releases</span>
          <span class="i-lucide-arrow-right text-xs"></span>
        </a>
      </div>
    </section>
  </div>
</aside>
