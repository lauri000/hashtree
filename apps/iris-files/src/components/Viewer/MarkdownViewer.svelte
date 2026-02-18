<script lang="ts">
  import { marked, type Token, type Tokens } from 'marked';
  import DOMPurify from 'dompurify';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { routeStore } from '../../stores';

  interface Props {
    content: string;
    dirPath?: string[];
  }

  let { content, dirPath }: Props = $props();
  let route = $derived($routeStore);
  let containerEl: HTMLDivElement | undefined;

  function slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
  }

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

    const hash = window.location.hash;
    const qIndex = hash.indexOf('?');
    const basePath = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
    const params = new SvelteURLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');
    params.set('anchor', anchorId);
    history.replaceState(null, '', `${basePath}?${params.toString()}`);

    const el = document.getElementById(anchorId);
    el?.scrollIntoView();
  }

  let htmlContent = $derived.by(() => {
    const tokens = marked.lexer(content);

    if (route.npub && route.treeName) {
      const resolvedDir = dirPath ?? route.path.slice(0, -1);
      const basePath = [route.npub, route.treeName, ...resolvedDir];
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

  $effect(() => {
    const hash = window.location.hash;
    const qIndex = hash.indexOf('?');
    if (qIndex < 0) return;
    const params = new SvelteURLSearchParams(hash.slice(qIndex + 1));
    const anchorId = params.get('anchor');
    if (!anchorId) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(anchorId);
      el?.scrollIntoView({ block: 'center' });
    });
  });

  $effect(() => {
    const node = containerEl;
    if (!node) return;
    node.addEventListener('click', handleAnchorClick);
    return () => {
      node.removeEventListener('click', handleAnchorClick);
    };
  });
</script>

<div
  bind:this={containerEl}
  class="markdown-content p-4 lg:p-6 prose prose-sm max-w-none text-text-1"
>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
  {@html htmlContent}
</div>

<style>
  .markdown-content :global(h1),
  .markdown-content :global(h2),
  .markdown-content :global(h3),
  .markdown-content :global(h4),
  .markdown-content :global(h5),
  .markdown-content :global(h6) {
    position: relative;
  }

  .markdown-content :global(.heading-anchor) {
    margin-left: 0.5em;
    opacity: 0;
    text-decoration: none;
    color: var(--text-2);
    transition: opacity 0.15s;
  }

  .markdown-content :global(.heading-anchor)::before {
    content: '#';
  }

  .markdown-content :global(h1:hover .heading-anchor),
  .markdown-content :global(h2:hover .heading-anchor),
  .markdown-content :global(h3:hover .heading-anchor),
  .markdown-content :global(h4:hover .heading-anchor),
  .markdown-content :global(h5:hover .heading-anchor),
  .markdown-content :global(h6:hover .heading-anchor),
  .markdown-content :global(.heading-anchor:focus) {
    opacity: 1;
  }
</style>
