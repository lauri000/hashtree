<script lang="ts">
  import type { CID } from '@hashtree/core';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { routeStore } from '../../stores';
  import { nostrStore } from '../../nostr';
  import { createReleasesStore, type ReleaseSummary } from '../../stores/releases';
  import { loadProjectMeta, type ProjectMeta } from '../../stores/projectMeta';
  import { parseForkOriginLink } from '../../lib/gitRepoAnnouncements';

  interface Props {
    npub: string;
    repoName: string;
    repoCid: CID | null;
  }

  let { npub, repoName, repoCid }: Props = $props();

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

  let aboutText = $derived(projectMeta?.about ?? null);
  let homepage = $derived(projectMeta?.homepage ?? null);
  let forkOrigin = $derived(projectMeta?.forkedFrom ? parseForkOriginLink(projectMeta.forkedFrom) : null);
  let hasAboutSection = $derived(projectMetaLoading || !!aboutText || !!homepage || !!forkOrigin);

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

  function shouldShowTagChip(release: ReleaseSummary): boolean {
    if (!release.tag) return false;
    return release.tag.trim() !== release.title.trim();
  }
</script>

<aside class="w-full shrink-0 lg:sticky lg:top-4 lg:w-72" data-testid="repo-sidebar">
  <div class="flex flex-col">
    {#if hasAboutSection}
      <section class="px-4 py-4" data-testid="repo-project-sidebar">
        <div class="mb-3">
          <span class="text-base font-semibold text-text-1">About</span>
        </div>

        <div class="flex flex-col gap-3">
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
              class="inline-flex items-center gap-2 break-all text-sm text-accent no-underline hover:text-accent/80"
            >
              <span>{formatHomepageLabel(homepage)}</span>
            </a>
          {/if}

          {#if forkOrigin}
            <a
              href={forkOrigin.href}
              class="inline-flex items-center gap-2 break-all text-sm text-text-2 no-underline hover:text-accent"
            >
              <span class="i-lucide-git-fork shrink-0"></span>
              <span>Forked from {forkOrigin.label}</span>
            </a>
          {/if}
        </div>
      </section>

      <div class="h-px bg-surface-3" aria-hidden="true"></div>
    {/if}

    <section class="px-4 py-4" data-testid="repo-releases-sidebar">
      <div class="mb-3">
        <div class="flex min-w-0 items-center gap-2">
          <a
            href={buildReleasesHref()}
            class="text-base font-semibold text-text-1 no-underline hover:text-accent"
            data-testid="repo-releases-link"
          >
            Releases
          </a>
          {#if !releasesState.loading}
            <span class="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-3">
              {visibleReleases.length}
            </span>
          {/if}
        </div>
      </div>

      {#if releasesState.loading}
        <div class="flex items-center gap-2 py-1 text-sm text-text-3">
          <span class="i-lucide-loader-2 animate-spin"></span>
          Loading releases...
        </div>
      {:else if releasesState.error}
        <div class="py-1 text-sm text-danger">
          {releasesState.error}
        </div>
      {:else if latestRelease}
        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <span class="i-lucide-tag shrink-0 text-sm text-success"></span>
            <a
              href={buildReleaseHref(latestRelease)}
              class="text-base font-medium text-text-1 no-underline hover:text-accent"
              data-testid="repo-latest-release-link"
            >
              {latestRelease.title}
            </a>
            <span class="rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">
              Latest
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-2 text-xs text-text-3">
            {#if shouldShowTagChip(latestRelease)}
              <span class="font-mono rounded bg-surface-2 px-1.5 py-0.5">{latestRelease.tag}</span>
            {/if}
            <span>{formatDate(latestRelease.published_at ?? latestRelease.created_at)}</span>
          </div>

          {#if visibleReleases.length > 1}
            <a
              href={buildReleasesHref()}
              class="text-sm text-accent no-underline hover:text-accent/80"
            >
              +{visibleReleases.length - 1} release{visibleReleases.length - 1 !== 1 ? 's' : ''}
            </a>
          {/if}
        </div>
      {:else}
        <div class="py-1 text-sm text-text-3">
          No releases yet.
        </div>
      {/if}
    </section>
  </div>
</aside>
