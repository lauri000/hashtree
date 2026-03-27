<script lang="ts">
  import { routeStore, currentDirCidStore } from '../../stores';
  import { getHtreePrefix } from '../../lib/mediaUrl';
  import { getTree } from '../../store';

  interface Props {
    content: string;
    fileName: string;
  }

  let { content, fileName }: Props = $props();

  const PREVIEW_CSP = "default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src * 'unsafe-inline'; font-src * data: blob:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none';";

  let route = $derived($routeStore);
  let currentDirCid = $derived($currentDirCidStore);
  let iframeSrc = $state('');

  let baseUrl = $derived.by(() => {
    if (!route.npub || !route.treeName) return '';

    const encodedTreeName = encodeURIComponent(route.treeName);
    const dirPath = route.path.slice(0, -1);
    const encodedPath = dirPath.map(encodeURIComponent).join('/');

    let base = `/htree/${route.npub}/${encodedTreeName}`;
    if (encodedPath) {
      base += `/${encodedPath}`;
    }
    base += '/';

    if (typeof window !== 'undefined') {
      const prefix = getHtreePrefix();
      if (prefix) {
        return new URL(base, prefix).toString();
      }
      if (window.location?.origin) {
        return new URL(base, window.location.origin).toString();
      }
    }
    return base;
  });

  function rewriteRootRelativeUrl(value: string | null): string | null {
    if (!value) return null;
    if (value.startsWith('//')) return value;
    if (value.startsWith('data:') || value.startsWith('blob:')) return value;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
    if (value.startsWith('/htree/')) return value;
    if (value.startsWith('/')) return value.slice(1);
    return value;
  }

  function rewriteRootRelativeSrcset(value: string | null): string | null {
    if (!value) return null;
    const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    return entries.map((entry) => {
      const parts = entry.split(/\s+/);
      const url = parts.shift() ?? '';
      const updated = rewriteRootRelativeUrl(url) ?? url;
      return [updated, ...parts].join(' ');
    }).join(', ');
  }

  function rewriteRootRelativeAttributes(doc: Document): void {
    const linkRelAllowlist = new Set([
      'stylesheet',
      'icon',
      'shortcut',
      'apple-touch-icon',
      'manifest',
      'preload',
      'modulepreload',
    ]);

    for (const link of Array.from(doc.querySelectorAll('link[href]'))) {
      const rel = (link.getAttribute('rel') || '').toLowerCase();
      const tokens = rel.split(/\s+/).filter(Boolean);
      if (!tokens.some((token) => linkRelAllowlist.has(token))) continue;
      const updated = rewriteRootRelativeUrl(link.getAttribute('href'));
      if (updated && updated !== link.getAttribute('href')) {
        link.setAttribute('href', updated);
      }
    }

    for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
      const updated = rewriteRootRelativeUrl(img.getAttribute('src'));
      if (updated && updated !== img.getAttribute('src')) {
        img.setAttribute('src', updated);
      }
    }

    for (const source of Array.from(doc.querySelectorAll('source[src]'))) {
      const updated = rewriteRootRelativeUrl(source.getAttribute('src'));
      if (updated && updated !== source.getAttribute('src')) {
        source.setAttribute('src', updated);
      }
    }

    for (const media of Array.from(doc.querySelectorAll('video[poster]'))) {
      const updated = rewriteRootRelativeUrl(media.getAttribute('poster'));
      if (updated && updated !== media.getAttribute('poster')) {
        media.setAttribute('poster', updated);
      }
    }

    for (const element of Array.from(doc.querySelectorAll('img[srcset], source[srcset]'))) {
      const updated = rewriteRootRelativeSrcset(element.getAttribute('srcset'));
      if (updated && updated !== element.getAttribute('srcset')) {
        element.setAttribute('srcset', updated);
      }
    }
  }

  function isRelativeResource(href: string | null): href is string {
    if (!href) return false;
    if (href.startsWith('//')) return false;
    if (href.startsWith('data:') || href.startsWith('blob:')) return false;
    return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
  }

  function normalizeRelativePath(href: string): string[] {
    const cleanHref = href.split(/[?#]/)[0];
    const parts = cleanHref.split('/').filter((part) => part.length > 0);
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') {
        stack.pop();
        continue;
      }
      stack.push(part);
    }
    return stack;
  }

  function splitUrlPath(value: string): { path: string; suffix: string } {
    const match = value.match(/^[^?#]+/);
    const path = match ? match[0] : '';
    const suffix = value.slice(path.length);
    return { path, suffix };
  }

  function resolveRelativePath(baseParts: string[], relative: string): string[] {
    const parts = relative.split('/').filter((part) => part.length > 0);
    const stack = [...baseParts];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') {
        stack.pop();
        continue;
      }
      stack.push(part);
    }
    return stack;
  }

  function guessMimeTypeFromPath(path: string): string {
    const lower = path.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.ico')) return 'image/x-icon';
    if (lower.endsWith('.avif')) return 'image/avif';
    if (lower.endsWith('.woff2')) return 'font/woff2';
    if (lower.endsWith('.woff')) return 'font/woff';
    if (lower.endsWith('.ttf')) return 'font/ttf';
    if (lower.endsWith('.otf')) return 'font/otf';
    if (lower.endsWith('.css')) return 'text/css';
    return 'application/octet-stream';
  }

  function bytesToBase64(data: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
  }

  async function inlineCssUrls(
    cssText: string,
    cssPath: string,
    dirCid: typeof currentDirCid,
    tree: ReturnType<typeof getTree>
  ): Promise<string> {
    const matches = Array.from(cssText.matchAll(/url\((['"]?)([^'")]+)\1\)/gi));
    if (matches.length === 0 || !dirCid) return cssText;

    const baseParts = cssPath.split('/').filter(Boolean).slice(0, -1);
    let result = '';
    let lastIndex = 0;

    for (const match of matches) {
      const full = match[0];
      const quote = match[1] ?? '';
      const rawUrl = match[2] ?? '';
      const index = match.index ?? 0;
      result += cssText.slice(lastIndex, index);
      lastIndex = index + full.length;

      const url = rawUrl.trim();
      if (!url || url.startsWith('#') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
        result += full;
        continue;
      }

      const { path, suffix } = splitUrlPath(url);
      if (!path || path.startsWith('/htree/')) {
        result += full;
        continue;
      }

      const resolvedParts = path.startsWith('/')
        ? normalizeRelativePath(path)
        : resolveRelativePath(baseParts, path);

      if (resolvedParts.length === 0) {
        result += full;
        continue;
      }

      try {
        const resolved = await tree.resolvePath(dirCid, resolvedParts);
        if (!resolved) {
          result += full;
          continue;
        }
        const data = await tree.readFile(resolved.cid);
        if (!data) {
          result += full;
          continue;
        }
        const mimeType = guessMimeTypeFromPath(resolvedParts[resolvedParts.length - 1] || path);
        const base64 = bytesToBase64(data);
        result += `url(${quote}data:${mimeType};base64,${base64}${suffix}${quote})`;
      } catch {
        result += full;
      }
    }

    result += cssText.slice(lastIndex);
    return result;
  }

  function ensureHead(doc: Document): HTMLHeadElement {
    let head = doc.querySelector('head');
    if (head) return head;
    head = doc.createElement('head');
    doc.documentElement.prepend(head);
    return head;
  }

  function upsertHttpEquivMeta(doc: Document, head: HTMLElement, key: string, value: string): void {
    const selector = `meta[http-equiv="${key}"]`;
    const existing = head.querySelector(selector) as HTMLMetaElement | null;
    const meta = existing ?? doc.createElement('meta');
    meta.setAttribute('http-equiv', key);
    meta.setAttribute('content', value);
    if (!existing) head.prepend(meta);
  }

  function upsertNamedMeta(doc: Document, head: HTMLElement, name: string, value: string): void {
    const selector = `meta[name="${name}"]`;
    const existing = head.querySelector(selector) as HTMLMetaElement | null;
    const meta = existing ?? doc.createElement('meta');
    meta.setAttribute('name', name);
    meta.setAttribute('content', value);
    if (!existing) head.prepend(meta);
  }

  async function buildPreviewHtml(contentValue: string, baseHref: string, dirCid: typeof currentDirCid): Promise<string> {
    if (typeof DOMParser === 'undefined') {
      return contentValue;
    }

    const doc = new DOMParser().parseFromString(contentValue, 'text/html');
    if (!doc.documentElement) return contentValue;

    const head = ensureHead(doc);

    const existingBase = head.querySelector('base');
    if (existingBase) {
      existingBase.setAttribute('href', baseHref);
    } else {
      const baseEl = doc.createElement('base');
      baseEl.setAttribute('href', baseHref);
      head.prepend(baseEl);
    }

    upsertHttpEquivMeta(doc, head, 'Content-Security-Policy', PREVIEW_CSP);
    upsertNamedMeta(doc, head, 'referrer', 'no-referrer');
    rewriteRootRelativeAttributes(doc);

    if (dirCid) {
      const tree = getTree();
      const decoder = new TextDecoder('utf-8');

      const styles = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'));
      for (const link of styles) {
        const href = link.getAttribute('href');
        if (!isRelativeResource(href)) continue;
        const parts = normalizeRelativePath(href);
        if (parts.length === 0) continue;
        try {
          const resolved = await tree.resolvePath(dirCid, parts);
          if (!resolved) continue;
          const data = await tree.readFile(resolved.cid);
          if (!data) continue;
          const styleEl = doc.createElement('style');
          const cssPath = normalizeRelativePath(href).join('/');
          const cssText = decoder.decode(data);
          styleEl.textContent = await inlineCssUrls(cssText, cssPath, dirCid, tree);
          link.replaceWith(styleEl);
        } catch {
          // Keep original link when local inlining fails.
        }
      }

      const images = Array.from(doc.querySelectorAll('img[src], source[src]'));
      for (const img of images) {
        const src = img.getAttribute('src');
        if (!isRelativeResource(src)) continue;
        const parts = normalizeRelativePath(src);
        if (parts.length === 0) continue;
        try {
          const resolved = await tree.resolvePath(dirCid, parts);
          if (!resolved) continue;
          const data = await tree.readFile(resolved.cid);
          if (!data) continue;
          const mimeType = guessMimeTypeFromPath(parts[parts.length - 1] || src || '');
          const base64 = bytesToBase64(data);
          img.setAttribute('src', `data:${mimeType};base64,${base64}`);
        } catch {
          // Keep original src when local inlining fails.
        }
      }
    }

    const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : '';
    return doctype + doc.documentElement.outerHTML;
  }

  $effect(() => {
    if (!content || !baseUrl) {
      return;
    }

    let localSrc = '';
    let cancelled = false;

    void (async () => {
      const modifiedHtml = await buildPreviewHtml(content, baseUrl, currentDirCid);
      if (cancelled) return;
      const blob = new Blob([modifiedHtml], { type: 'text/html' });
      localSrc = URL.createObjectURL(blob);
      iframeSrc = localSrc;
    })();

    return () => {
      cancelled = true;
      if (iframeSrc === localSrc) {
        iframeSrc = '';
      }
      if (localSrc) {
        URL.revokeObjectURL(localSrc);
      }
    };
  });
</script>

<div class="flex-1 flex flex-col min-h-0" data-testid="html-viewer" data-htree-base={baseUrl}>
  <div class="px-3 py-2 text-xs text-text-2 border-b border-base-300 bg-base-100/80">
    Secure preview only. Scripts, forms, workers, and persistence are disabled here.
  </div>

  {#if iframeSrc}
    <iframe
      src={iframeSrc}
      class="flex-1 w-full border-0 bg-white"
      sandbox=""
      title={fileName}
    ></iframe>
  {:else}
    <div class="flex-1 flex items-center justify-center text-muted">
      Loading...
    </div>
  {/if}
</div>
