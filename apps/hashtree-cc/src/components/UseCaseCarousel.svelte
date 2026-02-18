<script lang="ts">
  const slides = [
    {
      src: '/screenshot-iris-files.webp',
      title: 'Iris Files',
      desc: 'Git repos, file manager, pull requests, issues — all decentralized.',
      href: 'https://files.iris.to',
    },
    {
      src: '/screenshot-iris-docs.webp',
      title: 'Iris Docs',
      desc: 'Collaborative documents with comments and real-time editing.',
      href: 'https://docs.iris.to',
    },
    {
      src: '/screenshot-iris-video.webp',
      title: 'Iris Video',
      desc: 'Video streaming and playlists over content-addressed storage.',
      href: 'https://video.iris.to',
    },
    {
      src: '/screenshot-git-push.webp',
      title: 'Decentralized Git',
      desc: 'Push and pull repos with htree:// URLs. No server required.',
    },
  ];

  let current = $state(0);
  let autoInterval: ReturnType<typeof setInterval> | undefined;

  function startAuto() {
    stopAuto();
    autoInterval = setInterval(() => {
      current = (current + 1) % slides.length;
    }, 5000);
  }

  function stopAuto() {
    if (autoInterval) clearInterval(autoInterval);
    autoInterval = undefined;
  }

  function go(i: number) {
    current = i;
    startAuto();
  }

  function prev() {
    go((current - 1 + slides.length) % slides.length);
  }

  function next() {
    go((current + 1) % slides.length);
  }

  $effect(() => {
    startAuto();
    return stopAuto;
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="bg-surface-1 rounded-xl p-6 mb-8 outline-none"
  role="region"
  aria-label="Use case carousel"
  tabindex="0"
  onkeydown={(e) => {
    if (e.key === 'ArrowRight') { next(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { prev(); e.preventDefault(); }
  }}
  onmouseenter={stopAuto}
  onmouseleave={startAuto}
  onfocusin={stopAuto}
  onfocusout={startAuto}
>
  <h2 class="text-3xl md:text-4xl font-bold text-text-1 mb-6 text-center">
    Built on Hashtree
  </h2>

  <div class="relative select-none max-w-lg mx-auto">
    <div class="overflow-hidden rounded-lg">
      <div
        class="flex transition-transform duration-400 ease-in-out"
        style="transform: translateX(-{current * 100}%)"
      >
        {#each slides as slide}
          <div class="w-full shrink-0">
            <a
              href={slide.href}
              target="_blank"
              rel="noopener"
              class="block"
              class:pointer-events-none={!slide.href}
            >
              <img
                src={slide.src}
                alt={slide.title}
                class="w-full block"
                draggable="false"
              />
            </a>
          </div>
        {/each}
      </div>
    </div>

    <!-- Caption -->
    <div class="mt-3 mb-2 text-center">
      <p class="text-text-1 font-semibold mb-1">
        {#if slides[current].href}
          <a href={slides[current].href} target="_blank" rel="noopener" class="text-accent hover:underline">{slides[current].title}</a>
        {:else}
          {slides[current].title}
        {/if}
      </p>
      <p class="text-text-3 text-sm">{slides[current].desc}</p>
    </div>

    <!-- Prev / Next -->
    <button
      class="absolute left-0 top-0 h-full w-10 flex-center text-text-1 outline-none"
      onclick={prev}
      aria-label="Previous"
    >
      <span class="i-lucide-chevron-left"></span>
    </button>
    <button
      class="absolute right-0 top-0 h-full w-10 flex-center text-text-1 outline-none"
      onclick={next}
      aria-label="Next"
    >
      <span class="i-lucide-chevron-right"></span>
    </button>
  </div>

  <!-- Dots -->
  <div class="flex justify-center gap-2 mt-4">
    {#each slides as _, i}
      <button
        class="w-2 h-2 rounded-full transition-colors {i === current ? 'bg-accent' : 'bg-surface-3 hover:bg-text-3'}"
        onclick={() => go(i)}
        aria-label="Slide {i + 1}"
      ></button>
    {/each}
  </div>
</div>

