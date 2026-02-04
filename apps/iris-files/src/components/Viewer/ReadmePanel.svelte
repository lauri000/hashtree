<script lang="ts">
  /**
   * ReadmePanel - Bordered panel for displaying README.md content
   */
  import { marked, type Token, type Tokens } from 'marked';
  import DOMPurify from 'dompurify';
  import { LinkType, type TreeEntry } from '@hashtree/core';
  import { routeStore } from '../../stores';

  interface Props {
    content: string;
    entries: TreeEntry[];
    canEdit: boolean;
  }

  let { content, entries, canEdit }: Props = $props();
  let route = $derived($routeStore);

  // Slugify text for anchor IDs (GitHub-style)
  function slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
  }

  // Custom renderer for headings with anchor links
  const renderer = new marked.Renderer();
  renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
    const id = slugify(text);
    const anchor = `<a class="heading-anchor" data-anchor="${id}" href="#" aria-label="Link to this section"></a>`;
    return `<h${depth} id="${id}">${text}${anchor}</h${depth}>`;
  };

  function handleAnchorClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const anchor = target.closest('.heading-anchor') as HTMLAnchorElement | null;
    if (!anchor) return;

    event.preventDefault();
    const anchorId = anchor.dataset.anchor;
    if (!anchorId) return;

    // Update URL with anchor query param
    const hash = window.location.hash;
    const qIndex = hash.indexOf('?');
    const basePath = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
    const params = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');
    params.set('anchor', anchorId);
    history.replaceState(null, '', `${basePath}?${params.toString()}`);

    // Scroll to element
    const el = document.getElementById(anchorId);
    el?.scrollIntoView();
  }

  // Convert markdown to HTML, transforming relative links to hash URLs
  let htmlContent = $derived.by(() => {
    const tokens = marked.lexer(content);

    // Transform relative links to full hash URLs
    if (route.npub && route.treeName) {
      const basePath = [route.npub, route.treeName, ...route.path];
      marked.walkTokens(tokens, (token: Token) => {
        if (token.type === 'link') {
          const link = token as Tokens.Link;
          const href = link.href;
          if (href && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('#')) {
            const resolved = [...basePath, ...href.split('/')].filter(Boolean);
            link.href = '#/' + resolved.map(encodeURIComponent).join('/');
          }
        }
      });
    }

    return DOMPurify.sanitize(marked.parser(tokens, { renderer }), {
      ADD_ATTR: ['id', 'data-anchor'],
    });
  });

  // Scroll to anchor from URL on load
  $effect(() => {
    const hash = window.location.hash;
    const qIndex = hash.indexOf('?');
    if (qIndex < 0) return;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const anchorId = params.get('anchor');
    if (!anchorId) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(anchorId);
      el?.scrollIntoView({ block: 'center' });
    });
  });

  function handleEdit() {
    const readmeEntry = entries.find(
      e => e.name.toLowerCase() === 'readme.md' && e.type !== LinkType.Dir
    );
    if (readmeEntry) {
      // Navigate to edit the README - use actual filename from entry
      const parts: string[] = [];
      if (route.npub && route.treeName) {
        parts.push(route.npub, route.treeName, ...route.path, readmeEntry.name);
      }
      window.location.hash = '/' + parts.map(encodeURIComponent).join('/') + '?edit=1';
    }
  }

</script>

<div class="bg-surface-0 b-1 b-surface-3 b-solid rounded-lg overflow-hidden">
  <div class="flex items-center justify-between px-4 py-2 b-b-1 b-b-solid b-b-surface-3">
    <div class="flex items-center gap-2">
      <span class="i-lucide-book-open text-text-2"></span>
      <span class="text-sm font-medium">README.md</span>
    </div>
    {#if canEdit}
      <button
        onclick={handleEdit}
        class="btn-ghost text-xs px-2 py-1"
      >
        Edit
      </button>
    {/if}
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="readme-content p-4 lg:p-6 prose prose-sm max-w-none text-text-1" onclick={handleAnchorClick}>
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
    {@html htmlContent}
  </div>
</div>

<style>
  .readme-content :global(h1),
  .readme-content :global(h2),
  .readme-content :global(h3),
  .readme-content :global(h4),
  .readme-content :global(h5),
  .readme-content :global(h6) {
    position: relative;
  }

  .readme-content :global(.heading-anchor) {
    margin-left: 0.5em;
    opacity: 0;
    text-decoration: none;
    color: var(--text-2);
    transition: opacity 0.15s;
  }

  .readme-content :global(.heading-anchor)::before {
    content: '#';
  }

  .readme-content :global(h1:hover .heading-anchor),
  .readme-content :global(h2:hover .heading-anchor),
  .readme-content :global(h3:hover .heading-anchor),
  .readme-content :global(h4:hover .heading-anchor),
  .readme-content :global(h5:hover .heading-anchor),
  .readme-content :global(h6:hover .heading-anchor),
  .readme-content :global(.heading-anchor:focus) {
    opacity: 1;
  }
</style>
