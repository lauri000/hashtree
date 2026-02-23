<script lang="ts">
  import VisibilityIcon from '../VisibilityIcon.svelte';
  import { Avatar } from '../User';

  interface Props {
    href: string;
    title: string;
    ownerPubkey?: string | null;
    visibility?: string;
    updatedAt?: number;
  }

  let { href, title, ownerPubkey, visibility, updatedAt = 0 }: Props = $props();

  const updatedLabel = $derived(updatedAt > 0 ? new Date(updatedAt).toLocaleDateString() : '');
</script>

<a
  {href}
  class="bg-surface-1 rounded-lg b-1 b-solid b-surface-3 hover:b-accent hover:shadow-md transition-all no-underline flex flex-col p-4 gap-4 min-h-36"
>
  <div class="flex items-start justify-between gap-3">
    <h3 class="text-base font-semibold text-text-1 break-words line-clamp-2">{title}</h3>
    <VisibilityIcon {visibility} class="text-text-3 text-sm shrink-0" />
  </div>
  <div class="mt-auto flex items-center justify-between gap-2 text-xs text-text-3">
    <div class="flex items-center gap-1.5 min-w-0">
      {#if ownerPubkey}
        <Avatar pubkey={ownerPubkey} size={16} />
      {/if}
      <span class="truncate">Board</span>
    </div>
    {#if updatedLabel}
      <span class="shrink-0">{updatedLabel}</span>
    {/if}
  </div>
</a>
