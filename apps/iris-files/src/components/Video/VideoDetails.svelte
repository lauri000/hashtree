<script lang="ts">
  import type { TreeVisibility } from '@hashtree/core';
  import type { Snippet } from 'svelte';

  import VisibilityIcon from '../VisibilityIcon.svelte';
  import { Avatar, Name } from '../User';
  import VideoDescription from './VideoDescription.svelte';

  interface Props {
    title?: string;
    visibility?: TreeVisibility | null;
    ownerHref?: string | null;
    ownerPubkey?: string | null;
    ownerMeta?: Snippet;
    ownerActions?: Snippet;
    pageActions?: Snippet;
    description?: string;
    descriptionClass?: string;
    descriptionStyle?: string;
    descriptionTimestamp?: string;
    descriptionMaxLines?: number;
    descriptionMaxChars?: number;
  }

  let {
    title = '',
    visibility = null,
    ownerHref = null,
    ownerPubkey = null,
    ownerMeta,
    ownerActions,
    pageActions,
    description = '',
    descriptionClass = 'bg-surface-1 text-sm text-text-1',
    descriptionStyle = undefined,
    descriptionTimestamp = undefined,
    descriptionMaxLines = undefined,
    descriptionMaxChars = undefined,
  }: Props = $props();
</script>

{#if title}
  <div class="mb-3 flex items-center gap-2">
    {#if visibility && visibility !== 'public'}
      <VisibilityIcon visibility={visibility} class="mr-1 text-base text-text-3" />
    {/if}
    <h1 class="min-w-0 break-words text-xl font-semibold text-text-1" data-testid="video-title">{title}</h1>
  </div>
{/if}

<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
  <div class="flex min-w-0 items-center gap-3">
    {#if ownerHref && ownerPubkey}
      <a href={ownerHref} class="shrink-0">
        <Avatar pubkey={ownerPubkey} size={40} />
      </a>
      <div class="min-w-0">
        <a href={ownerHref} class="font-medium text-text-1 no-underline">
          <Name pubkey={ownerPubkey} />
        </a>
        {#if ownerMeta}
          {@render ownerMeta()}
        {/if}
      </div>
      {#if ownerActions}
        {@render ownerActions()}
      {/if}
    {/if}
  </div>

  {#if pageActions}
    <div class="flex shrink-0 flex-wrap items-center gap-1">
      {@render pageActions()}
    </div>
  {/if}
</div>

{#if description || descriptionTimestamp}
  <VideoDescription
    text={description}
    class={descriptionClass}
    style={descriptionStyle}
    timestamp={descriptionTimestamp}
    maxLines={descriptionMaxLines}
    maxChars={descriptionMaxChars}
  />
{/if}
