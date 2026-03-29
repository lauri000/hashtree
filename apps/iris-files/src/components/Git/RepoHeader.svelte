<script lang="ts">
  import type { CID, TreeVisibility } from '@hashtree/core';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { routeStore } from '../../stores';
  import { npubToPubkey } from '../../nostr';
  import VisibilityIcon from '../VisibilityIcon.svelte';
  import { Avatar, Name } from '../User';

  interface Props {
    backUrl: string;
    repoName: string;
    npub?: string | null;
    visibility?: TreeVisibility;
    isPermalink?: boolean;
    rootCid?: CID | null;
    sectionLabel?: string;
    sectionHref?: string;
  }

  let {
    backUrl,
    repoName,
    npub = null,
    visibility,
    isPermalink = false,
    rootCid = null,
    sectionLabel,
    sectionHref,
  }: Props = $props();

  let route = $derived($routeStore);
  let ownerPubkey = $derived(npubToPubkey(npub || '') || '');
  let repoParts = $derived(repoName.split('/').filter(Boolean));
  let repoHeaderName = $derived(repoParts.at(-1) ?? repoName);
  let repoRootHref = $derived.by(() => {
    if (!npub || !repoName) return backUrl;
    const params = new SvelteURLSearchParams();
    const linkKey = route.params.get('k');
    if (linkKey) params.set('k', linkKey);
    const query = params.toString();
    return `#/${[npub, ...repoParts].map(encodeURIComponent).join('/')}${query ? `?${query}` : ''}`;
  });
</script>

<div class="flex min-w-0 flex-1 flex-col justify-center gap-1" data-testid="repo-header-row">
  <div class="flex min-w-0 items-center gap-2">
    <a href={backUrl} class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8 no-underline inline-flex items-center justify-center shrink-0" title="Back">
      <span class="i-lucide-chevron-left text-lg"></span>
    </a>
    {#if npub && ownerPubkey}
      <a
        href="#/{npub}/profile"
        class="inline-flex min-w-0 items-center gap-1.5 text-sm leading-none text-text-2 hover:opacity-80"
        aria-label="View repo owner profile"
      >
        <Avatar pubkey={ownerPubkey} size={20} showBadge={true} />
        <Name pubkey={ownerPubkey} class="min-w-0 truncate text-sm leading-none text-text-2 hover:text-accent hover:underline" />
      </a>
      <span class="shrink-0 text-text-3">/</span>
    {:else if isPermalink}
      {#if rootCid?.key}
        <span class="relative inline-flex items-center shrink-0 text-text-2" title="Encrypted permalink">
          <span class="i-lucide-link"></span>
          <span class="i-lucide-lock absolute -bottom-0.5 -right-1.5 text-[0.6em]"></span>
        </span>
      {:else}
        <span class="i-lucide-globe text-text-2 shrink-0" title="Public permalink"></span>
      {/if}
    {/if}
    {#if visibility}
      <VisibilityIcon {visibility} class="text-text-2 shrink-0" />
    {/if}
    <a
      href={repoRootHref}
      class="min-w-0 shrink-0 truncate no-underline text-sm font-medium text-text-1 leading-none hover:text-accent hover:underline"
    >
      {repoHeaderName}
    </a>
    {#if sectionLabel}
      <span class="shrink-0 text-text-3">/</span>
      {#if sectionHref}
        <a
          href={sectionHref}
          class="min-w-0 truncate no-underline text-sm font-medium text-text-2 leading-none hover:text-accent hover:underline"
        >
          {sectionLabel}
        </a>
      {:else}
        <span class="min-w-0 truncate text-sm font-medium text-text-2 leading-none">
          {sectionLabel}
        </span>
      {/if}
    {/if}
  </div>
</div>
