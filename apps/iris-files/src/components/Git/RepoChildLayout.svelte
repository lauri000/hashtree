<script lang="ts">
  import type { CID, TreeVisibility } from '@hashtree/core';
  import type { Snippet } from 'svelte';
  import RepoHeader from './RepoHeader.svelte';
  import RepoTabNav from './RepoTabNav.svelte';

  interface Props {
    npub: string;
    repoName: string;
    backUrl: string;
    activeTab?: 'code' | 'pulls' | 'issues' | 'releases';
    showTabNav?: boolean;
    showReleasesTab?: boolean;
    rootCid?: CID | null;
    visibility?: TreeVisibility;
    isPermalink?: boolean;
    contentMaxWidthClass?: string;
    headerPaddingClass?: string;
    sectionLabel?: string;
    sectionHref?: string;
    children?: Snippet;
  }

  let {
    npub,
    repoName,
    backUrl,
    activeTab = 'code',
    showTabNav = true,
    showReleasesTab = false,
    rootCid = null,
    visibility,
    isPermalink = false,
    contentMaxWidthClass = 'max-w-7xl',
    headerPaddingClass = 'px-3 py-3',
    sectionLabel,
    sectionHref,
    children,
  }: Props = $props();
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
  {#if showTabNav}
    <RepoTabNav {npub} {repoName} {activeTab} {showReleasesTab} />
  {/if}

  <div class={`mx-auto flex w-full ${contentMaxWidthClass} flex-1 flex-col`}>
    <div class={headerPaddingClass}>
      <RepoHeader
        {backUrl}
        {npub}
        {rootCid}
        {visibility}
        {repoName}
        {isPermalink}
        {sectionLabel}
        {sectionHref}
      />
    </div>

    {@render children?.()}
  </div>
</div>
