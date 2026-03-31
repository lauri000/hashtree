<script lang="ts">
  import { marked, type Token, type Tokens } from 'marked';
  import DOMPurify from 'dompurify';
  import { SvelteMap, SvelteURLSearchParams } from 'svelte/reactivity';
  import { routeStore } from '../../stores';

  interface Props {
    content: string;
    dirPath?: string[];
  }

  let { content, dirPath }: Props = $props();
  let route = $derived($routeStore);
  let containerEl: HTMLDivElement | undefined;
  const copyResetTimers = new SvelteMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

  function slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
  }

  const renderer = new marked.Renderer();
  const defaultCodeRenderer = renderer.code.bind(renderer);
  renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
    const id = slugify(text);
    const anchor = `<a class="heading-anchor" data-anchor="${id}" href="#" aria-label="Link to this section"></a>`;
    return `<h${depth} id="${id}">${text}${anchor}</h${depth}>`;
  };
  renderer.code = (token: Tokens.Code) => {
    const renderedCode = defaultCodeRenderer(token).trimEnd();
    return `<div class="markdown-code-block"><div class="markdown-code-toolbar"><button type="button" class="markdown-copy-button" aria-label="Copy code" title="Copy code"><span class="markdown-copy-button-label">Copy</span></button></div>${renderedCode}</div>\n`;
  };

  function setCopyButtonLabel(button: HTMLButtonElement, label: string) {
    const labelEl = button.querySelector('.markdown-copy-button-label');
    if (labelEl) {
      labelEl.textContent = label;
    }
  }

  function resetCopyButton(button: HTMLButtonElement) {
    const timer = copyResetTimers.get(button);
    if (timer) {
      clearTimeout(timer);
      copyResetTimers.delete(button);
    }
    button.classList.remove('is-copied');
    setCopyButtonLabel(button, 'Copy');
  }

  function markCopyButtonCopied(button: HTMLButtonElement) {
    resetCopyButton(button);
    button.classList.add('is-copied');
    setCopyButtonLabel(button, 'Copied');
    const timer = setTimeout(() => {
      button.classList.remove('is-copied');
      setCopyButtonLabel(button, 'Copy');
      copyResetTimers.delete(button);
    }, 2000);
    copyResetTimers.set(button, timer);
  }

  async function handleCopyButtonClick(button: HTMLButtonElement) {
    const code = button.closest('.markdown-code-block')?.querySelector('code');
    const copyText = code?.textContent?.replace(/\n$/, '');
    if (!copyText || !navigator.clipboard?.writeText) return;

    try {
      await navigator.clipboard.writeText(copyText);
      markCopyButtonCopied(button);
    } catch (error) {
      console.error('Failed to copy markdown code block:', error);
    }
  }

  function handleContainerClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const copyButton = target.closest('.markdown-copy-button') as HTMLButtonElement | null;
    if (copyButton) {
      event.preventDefault();
      void handleCopyButtonClick(copyButton);
      return;
    }

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
    node.addEventListener('click', handleContainerClick);
    return () => {
      node.removeEventListener('click', handleContainerClick);
    };
  });

  $effect(() => {
    htmlContent;
    return () => {
      for (const timer of copyResetTimers.values()) {
        clearTimeout(timer);
      }
      copyResetTimers.clear();
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
  .markdown-content {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

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

  .markdown-content :global(p),
  .markdown-content :global(li),
  .markdown-content :global(blockquote),
  .markdown-content :global(a),
  .markdown-content :global(code) {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .markdown-content :global(:not(pre) > code) {
    white-space: break-spaces;
  }

  .markdown-content :global(pre) {
    white-space: pre-wrap;
    overflow-x: auto;
  }

  .markdown-content :global(.markdown-code-block) {
    margin: 1.25em 0;
    border: 1px solid var(--surface-3);
    border-radius: 0.875rem;
    overflow: hidden;
    background: var(--surface-1);
  }

  .markdown-content :global(.markdown-code-toolbar) {
    display: flex;
    justify-content: flex-end;
    padding: 0.5rem 0.625rem;
    border-bottom: 1px solid var(--surface-3);
    background: var(--surface-0);
  }

  .markdown-content :global(.markdown-copy-button) {
    border: 1px solid var(--surface-3);
    border-radius: 999px;
    background: var(--surface-1);
    color: var(--text-2);
    padding: 0.3rem 0.7rem;
    font-size: 0.75rem;
    line-height: 1.2;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s, color 0.15s;
  }

  .markdown-content :global(.markdown-copy-button:hover),
  .markdown-content :global(.markdown-copy-button:focus-visible) {
    background: var(--surface-2);
    color: var(--text-1);
    border-color: var(--surface-4);
    outline: none;
  }

  .markdown-content :global(.markdown-copy-button.is-copied) {
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 45%, var(--surface-3));
    background: color-mix(in srgb, var(--success) 10%, var(--surface-1));
  }

  .markdown-content :global(.markdown-code-block pre) {
    margin: 0;
    border-radius: 0;
    background: transparent;
  }
</style>
