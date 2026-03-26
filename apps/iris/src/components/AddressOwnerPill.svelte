<script lang="ts">
  import { describeAddressOwner } from '../lib/addressIdentity';

  interface Props {
    host: string;
    openProfile?: () => void;
  }

  let { host, openProfile }: Props = $props();
  let owner = $derived(describeAddressOwner(host));

  function handleMouseDown(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  function handleClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    openProfile?.();
  }
</script>

<button
  type="button"
  data-testid="address-owner-pill"
  data-profile-url={owner.profileUrl}
  class="relative z-20 inline-flex max-w-full items-center gap-2 rounded-full bg-surface-2/90 px-1.5 py-1 text-left text-text-1 transition-colors hover:bg-surface-3"
  title={owner.host}
  aria-label={`Open ${owner.name} profile`}
  onmousedown={handleMouseDown}
  onclick={handleClick}
>
  <span class="relative shrink-0">
    <img
      data-testid="address-owner-avatar"
      src={owner.avatarDataUrl}
      alt=""
      width="20"
      height="20"
      class="h-5 w-5 rounded-full"
    />
    {#if owner.showBadge}
      <span
        data-testid="address-owner-badge"
        class="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-white shadow-sm"
      >
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M20 6L9 17L4 12"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    {/if}
  </span>
  <span data-testid="address-owner-name" class="min-w-0 truncate text-sm font-medium">
    {owner.name}
  </span>
</button>
