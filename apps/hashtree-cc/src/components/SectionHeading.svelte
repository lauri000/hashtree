<script lang="ts">
  let { id, children }: { id: string; children: any } = $props();

  function onclick(e: MouseEvent) {
    e.preventDefault();
    history.pushState(null, '', `/#/dev/${id}`);
    document.getElementById(id)?.scrollIntoView({});
  }
</script>

<h2 {id} class="text-3xl md:text-4xl font-bold text-text-1 mb-4 text-center scroll-mt-4">
  <a href="/#/dev/{id}" {onclick} class="group no-underline text-text-1 hover:text-text-1">
    <span class="opacity-0 group-hover:opacity-40 transition-opacity">#</span> {@render children()}
  </a>
</h2>
