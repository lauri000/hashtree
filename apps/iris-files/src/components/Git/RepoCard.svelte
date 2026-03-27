<script lang="ts">
  import VisibilityIcon from '../VisibilityIcon.svelte';
  import { formatTimeAgo } from '../../utils/format';
  import { Avatar, Name } from '../User';

  interface Props {
    href: string;
    name: string;
    visibility?: string;
    createdAt?: number;
    metaLabel?: string;
    ownerPubkey?: string;
    accentIcon?: 'bookmark' | 'heart';
  }

  let {
    href,
    name,
    visibility,
    createdAt,
    metaLabel,
    ownerPubkey,
    accentIcon,
  }: Props = $props();

  let secondaryLabel = $derived(metaLabel ?? (createdAt ? formatTimeAgo(createdAt) : 'No recent activity'));
</script>

<a
  {href}
  class="group bg-surface-1 rounded-2xl border border-surface-3 hover:border-accent/50 hover:shadow-lg transition-all no-underline overflow-hidden"
>
  <div class="h-full min-h-44 p-5 flex flex-col gap-5">
    <div class="flex items-start justify-between gap-3">
      <div class="h-12 w-12 rounded-xl bg-accent/12 text-accent border border-accent/20 flex items-center justify-center">
        <span class="i-lucide-git-branch-plus text-xl"></span>
      </div>
      <div class="flex items-center gap-2 text-text-3">
        {#if accentIcon === 'bookmark'}
          <span class="i-lucide-bookmark text-accent" title="Saved repository"></span>
        {:else if accentIcon === 'heart'}
          <span class="i-lucide-heart fill-current text-accent" title="Liked repository"></span>
        {/if}
        {#if visibility}
          <VisibilityIcon {visibility} class="text-text-3" />
        {/if}
      </div>
    </div>

    {#if ownerPubkey}
      <div class="flex min-w-0 items-center gap-2 text-sm text-text-2">
        <Avatar pubkey={ownerPubkey} size={18} />
        <Name pubkey={ownerPubkey} class="min-w-0 truncate text-sm text-text-2" />
      </div>
    {/if}

    <div class="mt-auto space-y-1.5">
      <h3 class="m-0 text-lg font-semibold text-text-1 break-all">{name}</h3>
      <div class="text-sm text-text-2">{secondaryLabel}</div>
    </div>
  </div>
</a>
