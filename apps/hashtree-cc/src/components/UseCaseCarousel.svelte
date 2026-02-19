<script lang="ts">
  import SectionHeading from './SectionHeading.svelte';

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
      src: '/screenshot-iris-chat.webp',
      title: 'Iris Chat',
      desc: 'Secure file sharing in a nostr-based encrypted chat.',
      href: 'https://chat.iris.to',
    },
    {
      src: '/screenshot-git-push.webp',
      title: 'Decentralized Git',
      desc: 'Push and pull repos with htree:// URLs. No server required.',
    },
  ];

  let current = $state(0);
  let dragOffset = $state(0);
  let isDragging = $state(false);
  let autoInterval: ReturnType<typeof setInterval> | undefined;
  let viewportEl: HTMLDivElement | null = null;
  let isHovered = false;
  let hasFocusWithin = false;

  const axisLockThresholdPx = 8;
  const swipeThresholdRatio = 0.25;
  const minSwipeDistancePx = 24;
  const velocityThresholdPxPerMs = 0.35;

  let dragStartX = 0;
  let dragStartY = 0;
  let dragLastX = 0;
  let dragLastAt = 0;
  let velocityX = 0;
  let dragAxis: 'unknown' | 'horizontal' | 'vertical' = 'unknown';

  function startAuto() {
    stopAuto();
    if (slides.length < 2 || isHovered || hasFocusWithin) return;
    autoInterval = setInterval(() => {
      current = (current + 1) % slides.length;
    }, 5000);
  }

  function stopAuto() {
    if (autoInterval) clearInterval(autoInterval);
    autoInterval = undefined;
  }

  function clearDragState() {
    dragStartX = 0;
    dragStartY = 0;
    dragLastX = 0;
    dragLastAt = 0;
    velocityX = 0;
    dragAxis = 'unknown';
  }

  function beginDrag(x: number, y: number) {
    isDragging = true;
    dragOffset = 0;
    clearDragState();
    dragStartX = x;
    dragStartY = y;
    dragLastX = x;
    dragLastAt = performance.now();
    stopAuto();
  }

  function finishDrag() {
    if (!isDragging) return;

    isDragging = false;

    const absDistance = Math.abs(dragOffset);
    const contentWidth = viewportEl?.clientWidth ?? 1;
    const swipeThreshold = Math.max(minSwipeDistancePx, contentWidth * swipeThresholdRatio);
    const isQuickSwipe = Math.abs(velocityX) > velocityThresholdPxPerMs && absDistance > minSwipeDistancePx;
    const shouldNavigate = dragAxis === 'horizontal' && (absDistance > swipeThreshold || isQuickSwipe);

    let direction: 'prev' | 'next' = dragOffset > 0 ? 'prev' : 'next';
    if (isQuickSwipe) {
      direction = velocityX > 0 ? 'prev' : 'next';
    }

    dragOffset = 0;
    clearDragState();

    if (shouldNavigate) {
      if (direction === 'prev') {
        prev();
      } else {
        next();
      }
      return;
    }

    startAuto();
  }

  function onPointerDown(e: PointerEvent) {
    if (slides.length < 2) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    viewportEl?.setPointerCapture(e.pointerId);
    beginDrag(e.clientX, e.clientY);
  }

  function onPointerMove(e: PointerEvent) {
    if (!isDragging) return;

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    if (
      dragAxis === 'unknown' &&
      (Math.abs(deltaX) > axisLockThresholdPx || Math.abs(deltaY) > axisLockThresholdPx)
    ) {
      dragAxis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
    }

    if (dragAxis !== 'horizontal') return;

    e.preventDefault();
    dragOffset = deltaX;

    const now = performance.now();
    const dt = now - dragLastAt;
    if (dt > 0) {
      velocityX = (e.clientX - dragLastX) / dt;
    }
    dragLastX = e.clientX;
    dragLastAt = now;
  }

  function onPointerUp(e: PointerEvent) {
    if (viewportEl?.hasPointerCapture(e.pointerId)) {
      viewportEl.releasePointerCapture(e.pointerId);
    }
    finishDrag();
  }

  function onPointerCancel(e: PointerEvent) {
    if (viewportEl?.hasPointerCapture(e.pointerId)) {
      viewportEl.releasePointerCapture(e.pointerId);
    }
    finishDrag();
  }

  function onMouseEnter() {
    isHovered = true;
    stopAuto();
  }

  function onMouseLeave() {
    isHovered = false;
    startAuto();
  }

  function onFocusIn() {
    hasFocusWithin = true;
    stopAuto();
  }

  function onFocusOut(e: FocusEvent) {
    const currentTarget = e.currentTarget;
    const relatedTarget = e.relatedTarget;
    if (
      currentTarget instanceof HTMLElement &&
      relatedTarget instanceof Node &&
      currentTarget.contains(relatedTarget)
    ) {
      return;
    }
    hasFocusWithin = false;
    startAuto();
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
    return () => {
      stopAuto();
    };
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
  onmouseenter={onMouseEnter}
  onmouseleave={onMouseLeave}
  onfocusin={onFocusIn}
  onfocusout={onFocusOut}
>
  <SectionHeading id="built-on-hashtree">Built on Hashtree</SectionHeading>

  <div class="relative select-none max-w-lg mx-auto">
    <div
      bind:this={viewportEl}
      class="overflow-hidden rounded-lg"
      style="touch-action: pan-y pinch-zoom;"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerCancel}
    >
      <div
        class="flex"
        style="transform: translateX(calc(-{current * 100}% + {dragOffset}px)); transition: {isDragging ? 'none' : 'transform 400ms ease-in-out'};"
      >
        {#each slides as slide}
          <div class="w-full shrink-0">
            <img
              src={slide.src}
              alt={slide.title}
              class="w-full block"
              draggable="false"
            />
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
      type="button"
      class="absolute left-2 top-1/2 z-10 -translate-y-1/2 h-9 w-9 rounded-full flex-center text-text-1 bg-surface-1/90 border border-surface-3 hover:bg-surface-2 outline-none"
      onpointerdown={(e) => e.stopPropagation()}
      onclick={(e) => { e.stopPropagation(); prev(); }}
      aria-label="Previous"
    >
      <span class="i-lucide-chevron-left"></span>
    </button>
    <button
      type="button"
      class="absolute right-2 top-1/2 z-10 -translate-y-1/2 h-9 w-9 rounded-full flex-center text-text-1 bg-surface-1/90 border border-surface-3 hover:bg-surface-2 outline-none"
      onpointerdown={(e) => e.stopPropagation()}
      onclick={(e) => { e.stopPropagation(); next(); }}
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
