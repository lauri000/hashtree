<script lang="ts">
  import VisibilityIcon from '../VisibilityIcon.svelte';
  import { formatTimeAgo } from '../../utils/format';

  interface Props {
    href: string;
    name: string;
    visibility?: string;
    createdAt?: number;
  }

  let { href, name, visibility, createdAt }: Props = $props();

  let updatedLabel = $derived(createdAt ? formatTimeAgo(createdAt) : 'No activity yet');
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
      <VisibilityIcon {visibility} class="text-text-3" />
    </div>

    <div class="mt-auto space-y-1.5">
      <h3 class="m-0 text-lg font-semibold text-text-1 break-all">{name}</h3>
      <div class="text-sm text-text-2">{updatedLabel}</div>
    </div>
  </div>
</a>
